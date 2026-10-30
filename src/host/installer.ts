/**
 * Global installation of a kernel CLI, driven by the machine's own npm.
 *
 * The install surface needs progress it can trust, so the percent it receives is
 * phase-based (resolve → download → link → verify) rather than invented from
 * elapsed time, and it only reaches 100 after `probeKernel` proves the binary
 * runs. Output is streamed as human-readable lines, never as a fabricated bar.
 */
import type { ChildProcess } from 'node:child_process'
import type { InstallEvent, ThirdPartyKernelId } from '../shared/protocol'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { KERNEL_PACKAGES } from '../shared/protocol'
import { nativeEnvironment, probeKernel } from './detect'

/** Percent each phase reports while it owns the install. */
const PHASES = [
  { pattern: /npm (?:http fetch|WARN|notice)/i, message: '正在解析依赖…', percent: 20 },
  { pattern: /reify|idealTree|placeDep/i, message: '正在下载内核包…', percent: 45 },
  { pattern: /link|bin|postinstall/i, message: '正在链接可执行文件…', percent: 75 },
] as const

export interface InstallHandle {
  events: AsyncIterable<InstallEvent>
  cancel: () => void
}

/**
 * Resolve the npm command that can install globally on this machine. npm's own
 * JS entry is preferred over the `npm.cmd` shim because spawn cannot execute a
 * batch file without a shell.
 */
function npmCommand(): { file: string, args: string[] } {
  const execPath = process.execPath
  const bundled = `${process.execPath.slice(0, Math.max(process.execPath.lastIndexOf('\\'), process.execPath.lastIndexOf('/')))}${process.platform === 'win32' ? '\\' : '/'}node_modules${process.platform === 'win32' ? '\\' : '/'}npm${process.platform === 'win32' ? '\\' : '/'}bin${process.platform === 'win32' ? '\\' : '/'}npm-cli.js`
  return { file: execPath, args: [bundled] }
}

/** Whether a path-derived npm entry is worth trying before the PATH lookup. */
async function npmEntry(): Promise<{ file: string, args: string[] }> {
  const candidate = npmCommand()
  const { access } = await import('node:fs/promises')
  try {
    await access(candidate.args[0]!)
    return candidate
  }
  catch {
    return { file: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [] }
  }
}

/**
 * Start one global install. The handle's `events` iterable is single-use and
 * ends after a terminal `done` or `error`; `cancel` stops the child and is
 * idempotent.
 */
export function installKernel(kernel: ThirdPartyKernelId): InstallHandle {
  const queue: InstallEvent[] = []
  let wake: (() => void) | undefined
  let finished = false
  let child: ChildProcess | undefined
  let cancelled = false
  let phase = 0
  let percent = 5

  const push = (event: InstallEvent): void => {
    queue.push(event)
    wake?.()
    wake = undefined
  }

  const finish = (event: InstallEvent): void => {
    if (finished)
      return
    finished = true
    push(event)
  }

  void (async () => {
    const npm = await npmEntry()
    if (cancelled) {
      finish({ type: 'error', message: '已取消安装。' })
      return
    }
    push({ type: 'step', message: '正在准备安装…', percent })
    child = spawn(npm.file, [...npm.args, 'install', '--global', KERNEL_PACKAGES[kernel]], {
      env: { ...nativeEnvironment(), npm_config_fund: 'false', npm_config_audit: 'false' },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    let buffered = ''
    const consume = (chunk: string): void => {
      buffered += chunk
      let newline = buffered.indexOf('\n')
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        newline = buffered.indexOf('\n')
        if (line === '')
          continue
        for (const step of PHASES) {
          if (step.percent > percent && step.pattern.test(line)) {
            percent = step.percent
            push({ type: 'step', message: step.message, percent })
          }
        }
        push({ type: 'tick', percent })
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', consume)
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4_000)
      consume(chunk)
    })
    child.on('error', (error) => {
      finish({ type: 'error', message: `无法启动 npm：${error.message}` })
    })
    child.on('close', (code) => {
      if (cancelled) {
        finish({ type: 'error', message: '已取消安装。' })
        return
      }
      if (code !== 0) {
        finish({ type: 'error', message: stderr.trim() || `npm 退出码 ${code ?? 'unknown'}` })
        return
      }
      phase = PHASES.length
      percent = 90
      push({ type: 'step', message: '正在验证内核…', percent })
      void probeKernel(kernel).then((result) => {
        if (cancelled) {
          finish({ type: 'error', message: '已取消安装。' })
          return
        }
        if (!result.installed) {
          finish({ type: 'error', message: result.hint ?? '安装完成但内核无法启动。' })
          return
        }
        percent = 100
        push({ type: 'step', message: '安装完成', percent })
        finish({ type: 'done', version: result.version })
      })
    })
    void phase
  })()

  return {
    events: {
      async* [Symbol.asyncIterator]() {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift()!
            continue
          }
          if (finished)
            return
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
      },
    },
    cancel: () => {
      if (cancelled)
        return
      cancelled = true
      child?.kill()
    },
  }
}
