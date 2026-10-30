/**
 * JSON-lines child-process transport shared by both kernels.
 *
 * Every kernel speaks newline-delimited JSON over stdio. The transport owns the
 * boring parts that are easy to get wrong: partial frames, bounded buffering,
 * request/response correlation with timeouts, and a close path that always ends
 * the child even when it ignores termination.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { KernelCommand } from './detect'
import { spawn } from 'node:child_process'
import process from 'node:process'

const MAX_FRAME_CHARS = 8 * 1024 * 1024
const MAX_STDERR_CHARS = 16 * 1024
const CLOSE_TIMEOUT_MS = 1_500

/** Default budget for one control request. */
export const REQUEST_TIMEOUT_MS = 60_000
/** Budget for interrupt-style requests that must not hang a turn. */
export const INTERRUPT_TIMEOUT_MS = 5_000

export class BridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'BridgeError'
  }
}

export function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void, reject: (error: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  // A rejected settlement can happen before the caller's first await.
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

/** Parse a protocol frame, rejecting anything that is not a JSON object. */
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BridgeError('BRIDGE_PROTOCOL', 'Expected a native protocol object')
  return value as Record<string, unknown>
}

export function stringField(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== 'string' || value[key] === '')
    throw new BridgeError('BRIDGE_PROTOCOL', `Missing native protocol field: ${key}`)
  return value[key]
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Correlates request ids with their pending promises. */
export class PendingRequests {
  private readonly requests = new Map<string | number, { finish: (error?: Error, value?: unknown) => void, timer: ReturnType<typeof setTimeout>, removeAbort: () => void }>()

  constructor(private readonly write: (value: unknown) => void) {}

  request(id: string | number, frame: unknown, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (signal?.aborted)
      return Promise.reject(new BridgeError('BRIDGE_ABORTED', 'Request was cancelled'))
    const result = deferred<unknown>()
    const settle = (error?: Error, value?: unknown): void => {
      const pending = this.requests.get(id)
      if (!pending)
        return
      this.requests.delete(id)
      clearTimeout(pending.timer)
      pending.removeAbort()
      if (error)
        result.reject(error)
      else
        result.resolve(value)
    }
    const aborted = (): void => settle(new BridgeError('BRIDGE_ABORTED', 'Request was cancelled'))
    const timer = setTimeout(() => settle(new BridgeError('BRIDGE_REQUEST_TIMEOUT', 'Native control request timed out')), timeoutMs)
    const removeAbort = (): void => signal?.removeEventListener('abort', aborted)
    this.requests.set(id, { finish: settle, timer, removeAbort })
    signal?.addEventListener('abort', aborted, { once: true })
    try {
      this.write(frame)
    }
    catch (error) {
      settle(errorFrom(error))
    }
    return result.promise
  }

  settle(id: string | number, value: unknown, error?: Error): void {
    this.requests.get(id)?.finish(error, value)
  }

  failAll(error: Error): void {
    for (const id of [...this.requests.keys()])
      this.settle(id, undefined, error)
  }
}

/** One long-lived JSON-lines child process. */
export class JsonLinesProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly closed = deferred<void>()
  private input = ''
  private stderr = ''
  private failure?: Error
  private closing?: Promise<void>
  private stopped = false
  private exited = false
  private handler?: (message: Record<string, unknown>) => void
  private failureHandler?: (error: Error) => void

  constructor(command: KernelCommand, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command.file))
      throw new BridgeError('BRIDGE_UNSAFE_EXECUTABLE', 'Windows 批处理包装器必须先解析为原生可执行文件')
    this.child = spawn(command.file, [...command.args, ...args], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.readChunk(chunk))
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_STDERR_CHARS)
    })
    this.child.stdout.on('error', error => this.fail(error))
    this.child.stdin.on('error', error => this.fail(error))
    this.child.on('error', error => this.fail(error))
    this.child.once('close', (code, signal) => {
      if (!this.stopped)
        this.fail(new BridgeError('BRIDGE_PROCESS_EXIT', `内核进程已退出（${signal ?? code}）${this.stderr.trim() ? `：${this.stderr.trim()}` : ''}`))
      this.stopped = true
      this.exited = true
      this.closed.resolve()
    })
  }

  onMessage(handler: (message: Record<string, unknown>) => void): void {
    this.handler = handler
  }

  onFailure(handler: (error: Error) => void): void {
    this.failureHandler = handler
    if (this.failure)
      handler(this.failure)
  }

  write(value: unknown): void {
    if (this.failure)
      throw this.failure
    if (this.stopped || !this.child.stdin.writable)
      throw new BridgeError('BRIDGE_PROCESS_CLOSED', '内核进程不可写入')
    const line = `${JSON.stringify(value)}\n`
    if (line.length > MAX_FRAME_CHARS)
      throw new BridgeError('BRIDGE_FRAME_LIMIT', '原生协议帧超过传输上限')
    this.child.stdin.write(line)
  }

  fail(error: Error): void {
    if (this.failure)
      return
    this.failure = error
    this.failureHandler?.(error)
    void this.close().catch(() => {})
  }

  close(graceful = false): Promise<void> {
    this.closing ??= this.stop(graceful)
    return this.closing
  }

  private async stop(graceful: boolean): Promise<void> {
    if (this.exited)
      return
    this.stopped = true
    if (graceful) {
      this.child.stdin.end()
      if (await this.waitForExit())
        return
    }
    this.child.stdin.destroy()
    this.child.kill('SIGTERM')
    if (await this.waitForExit())
      return
    this.child.kill('SIGKILL')
    if (!await this.waitForExit())
      throw new BridgeError('BRIDGE_PROCESS_STOP_TIMEOUT', '内核进程未能终止')
  }

  private async waitForExit(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const exited = await Promise.race([
      this.closed.promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(resolve, CLOSE_TIMEOUT_MS, false)
      }),
    ])
    clearTimeout(timer)
    return exited
  }

  private readChunk(chunk: string): void {
    if (this.stopped)
      return
    this.input += chunk
    let end = this.input.indexOf('\n')
    while (end >= 0) {
      const line = this.input.slice(0, end).trim()
      this.input = this.input.slice(end + 1)
      if (line.length > MAX_FRAME_CHARS) {
        this.fail(new BridgeError('BRIDGE_FRAME_LIMIT', '原生协议帧超过传输上限'))
        return
      }
      if (line !== '') {
        try {
          const message = record(JSON.parse(line))
          this.handler?.(message)
        }
        catch (error) {
          this.fail(error instanceof BridgeError ? error : new BridgeError('BRIDGE_PROTOCOL', `无法解析原生输出：${errorFrom(error).message}`))
          return
        }
      }
      if (this.stopped || this.failure)
        return
      end = this.input.indexOf('\n')
    }
    if (this.input.length > MAX_FRAME_CHARS)
      this.fail(new BridgeError('BRIDGE_FRAME_LIMIT', '原生协议帧超过传输上限'))
  }
}

/**
 * Server-to-client request handler registry. Kernel protocols both ask the
 * client for approvals and user input mid-turn; the session layer supplies the
 * answer and this type keeps the two shapes honest.
 */
export interface NativeRequestHandler {
  answer: (id: string | number, method: string, params: Record<string, unknown>) => Promise<void>
}
