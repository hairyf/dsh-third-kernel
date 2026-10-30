/**
 * Locate and probe the native CLIs. The same module proves "installed" for the
 * switcher, resolves what a session spawns, and reports the version the install
 * surface waits for.
 */
import type { ThirdPartyKernelId } from '../shared/protocol'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'

/** How to start one kernel: a program plus any arguments that precede the kernel's own. */
export interface KernelCommand {
  /** The program to spawn. */
  readonly file: string
  /** Arguments placed before the kernel's own (a JavaScript entry, when shimmed). */
  readonly args: readonly string[]
}

/** Children inherit the user's environment minus variables that would re-enter a harness. */
export function nativeEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env }
  for (const key of Object.keys(clean)) {
    if (/^(?:DSH_.*|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CODEX_THREAD_ID|NODE_OPTIONS)$/i.test(key))
      delete clean[key]
  }
  return clean
}

/** PATH directories, in order, from the process environment. */
function pathDirectories(env: NodeJS.ProcessEnv): string[] {
  const value = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
  return value.split(process.platform === 'win32' ? ';' : delimiter).filter(entry => entry !== '' && isAbsolute(entry))
}

async function executable(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile())
      return false
    await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  }
  catch {
    return false
  }
}

/** Official JavaScript entry each vendor's Windows `.cmd` shim wraps. */
const SHIM_ENTRIES = {
  codex: /node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js/,
  claude: /node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/](?:cli\.js|bin[\\/]claude\.exe)/,
} as const

/**
 * Resolve one kernel's command without running it.
 *
 * npm installs three kinds of launcher: a native `.exe`, which runs directly; a
 * `.cmd` shim, which `spawn` cannot execute without a shell; and — only on
 * Windows — an extension-less POSIX script that is not executable there at all.
 * The `.cmd` shim is therefore parsed and reduced to the entry it wraps, run with
 * this process's own node binary. A shim that does not name the vendor's official
 * entry is rejected rather than executed, because running an unrecognized batch
 * file is a command-injection path, not a convenience.
 */
export async function resolveExecutable(kernel: ThirdPartyKernelId, env: NodeJS.ProcessEnv = nativeEnvironment()): Promise<KernelCommand | null> {
  const name = kernel === 'codex' ? 'codex' : 'claude'
  for (const directory of pathDirectories(env)) {
    const extensions = process.platform === 'win32' ? ['.exe'] : ['']
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`)
      if (await executable(candidate))
        return { file: await realpath(candidate).catch(() => candidate), args: [] }
    }
    if (process.platform !== 'win32')
      continue
    const shim = await shimCommand(join(directory, `${name}.cmd`), kernel)
    if (shim !== null)
      return shim
  }
  return null
}

/**
 * Parse a Windows shim into the command that runs its payload.
 * @returns the node command, or null when the shim is not the vendor's own.
 */
async function shimCommand(shim: string, kernel: ThirdPartyKernelId): Promise<KernelCommand | null> {
  if (!await executable(shim))
    return null
  const text = await readFile(shim, 'utf8').catch(() => '')
  const match = SHIM_ENTRIES[kernel].exec(text)
  if (match === null)
    return null
  // The shim resolves its payload against its own directory (`dp0`), and the
  // matched fragment already starts inside that directory tree.
  const entry = join(dirname(shim), match[0].replace(/[\\/]/g, '/'))
  if (!await executable(entry))
    return null
  const resolved = await realpath(entry).catch(() => entry)
  // A native `.exe` payload runs directly; a JavaScript entry needs node.
  return /\.exe$/i.test(resolved) ? { file: resolved, args: [] } : { file: process.execPath, args: [resolved] }
}

/** Run one bounded probe and collect its combined output. */
function probe(command: KernelCommand, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null, output: string }> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command.file, [...command.args, ...args], { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    }
    catch (error) {
      reject(error)
      return
    }
    let output = ''
    let bytes = 0
    let settled = false
    const timer = setTimeout(() => fail(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs)
    function cleanup(): void {
      clearTimeout(timer)
      child.stdout?.off('data', collect)
      child.stderr?.off('data', collect)
      child.off('close', close)
      child.off('error', fail)
    }
    function fail(error: Error): void {
      if (settled)
        return
      settled = true
      cleanup()
      child.kill()
      reject(error)
    }
    function collect(chunk: Uint8Array): void {
      bytes += chunk.byteLength
      if (bytes > 256 * 1024) {
        fail(new Error('probe output exceeded its limit'))
        return
      }
      output += new TextDecoder().decode(chunk)
    }
    function close(code: number | null): void {
      if (settled)
        return
      settled = true
      cleanup()
      resolve({ code, output })
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', fail)
    child.on('close', close)
  })
}

export interface ProbeResult {
  installed: boolean
  version: string | null
  /** Printable form of what runs, for the UI to name the actual artifact. */
  executable: string | null
  /** The spawn recipe, present only for a usable install. */
  command: KernelCommand | null
  hint: string | null
}

/**
 * Prove one kernel is usable, not merely present: the launcher must answer
 * `--version` with a parseable version and advertise the streaming protocol the
 * session layer drives. An install failing either check is reported as broken
 * rather than handed a session.
 */
export async function probeKernel(kernel: ThirdPartyKernelId, env: NodeJS.ProcessEnv = nativeEnvironment()): Promise<ProbeResult> {
  const command = await resolveExecutable(kernel, env)
  if (command === null) {
    return {
      installed: false,
      version: null,
      executable: null,
      command: null,
      hint: kernel === 'codex'
        ? '未找到 codex 命令，选中本项会自动全局安装。'
        : '未找到 claude 命令，选中本项会自动全局安装。',
    }
  }
  const label = command.args.length === 0 ? command.file : command.args.join(' ')
  try {
    const version = await probe(command, ['--version'], env, 15_000)
    if (version.code !== 0)
      return { installed: false, version: null, executable: label, command: null, hint: '内核无法启动，请检查该安装。' }
    const match = /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/.exec(version.output)
    if (match === null)
      return { installed: false, version: null, executable: label, command: null, hint: '内核未返回可识别版本。' }
    const help = await probe(command, kernel === 'codex' ? ['app-server', '--help'] : ['--help'], env, 15_000)
    const capable = help.code === 0 && (kernel === 'codex' || /stream-json/.test(help.output))
    if (!capable)
      return { installed: false, version: match[0], executable: label, command: null, hint: '内核版本过旧，不支持所需的流式协议。' }
    return { installed: true, version: match[0], executable: label, command, hint: null }
  }
  catch (error) {
    return {
      installed: false,
      version: null,
      executable: label,
      command: null,
      hint: error instanceof Error ? error.message : '内核探测失败。',
    }
  }
}
