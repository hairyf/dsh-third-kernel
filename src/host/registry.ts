import type { ThirdPartyKernelId } from '../shared/protocol'
/**
 * Live kernel sessions, keyed by the id the browser uses for follow-up calls.
 * One map, one owner: routes read it, the plugin's disposer empties it.
 */
import type { KernelCommand } from './detect'
import type { KernelSession } from './session-types'
import { ClaudeSession } from './claude'
import { CodexSession } from './codex'

export const sessions = new Map<string, KernelSession>()

/**
 * Start a kernel child in `cwd`, complete its handshake, and register it.
 * The native id is the browser-facing key, so a restarted kernel gets a fresh
 * one and stale requests fail closed instead of reaching a stranger.
 */
export async function openSession(kernel: ThirdPartyKernelId, executable: KernelCommand, cwd: string): Promise<KernelSession> {
  const signal = AbortSignal.timeout(30_000)
  const session = kernel === 'codex'
    ? new CodexSession(executable, cwd, () => cwd)
    : new ClaudeSession(executable, cwd)
  try {
    await session.open(signal)
  }
  catch (error) {
    await session.dispose().catch(() => {})
    throw error
  }
  sessions.set(session.id, session)
  return session
}

/** Terminate every live kernel; used by the plugin's disposal path. */
export async function disposeSessions(): Promise<void> {
  const live = [...sessions.values()]
  sessions.clear()
  await Promise.all(live.map(session => session.dispose().catch(() => {})))
}
