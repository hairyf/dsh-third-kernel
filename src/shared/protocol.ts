/** Plugin id and wire contract shared by the host and browser halves. */
export const PLUGIN_ID = 'dsh-third-kernel'

/** Route prefix owning every kernel request on the authenticated `/api` channel. */
export const API_PREFIX = '/api/third-kernel'

/** Kernels selectable from the sidebar brand row. */
export const KERNEL_IDS = ['dsh', 'codex', 'claude'] as const

export type KernelId = (typeof KERNEL_IDS)[number]

/** A kernel this plugin can take the page over with. */
export type ThirdPartyKernelId = Exclude<KernelId, 'dsh'>

export const THIRD_PARTY_KERNELS: readonly ThirdPartyKernelId[] = ['codex', 'claude']

/**
 * Global npm package backing each kernel. Installing it globally is what
 * `npm i -g` below performs, and the postinstall of `@anthropic-ai/claude-code`
 * is what fetches its platform binary.
 */
export const KERNEL_PACKAGES: Record<ThirdPartyKernelId, string> = {
  codex: '@openai/codex@latest',
  claude: '@anthropic-ai/claude-code@latest',
}

/** Executable name each kernel publishes on PATH. */
export const KERNEL_BINARIES: Record<ThirdPartyKernelId, string> = {
  codex: 'codex',
  claude: 'claude',
}

/** Storage key the switcher's selection survives a reload under. */
export const SELECTION_KEY = 'dsh-third-kernel:selection'

export const ROUTES = {
  state: `${API_PREFIX}/state`,
  install: `${API_PREFIX}/install`,
  session: `${API_PREFIX}/session`,
  turn: `${API_PREFIX}/turn`,
  answer: `${API_PREFIX}/answer`,
  interrupt: `${API_PREFIX}/interrupt`,
  close: `${API_PREFIX}/close`,
} as const

/** One kernel's locally detected install state. */
export interface KernelState {
  id: KernelId
  installed: boolean
  /** `codex-cli 0.162.1` style version text when the probe succeeded. */
  version: string | null
  /** Resolved absolute executable, the install UI's proof of what runs. */
  executable: string | null
  /** Correction-oriented hint shown next to a failed detection. */
  hint: string | null
}

/** Events a turn stream may carry. Mirrors the two native protocols. */
export type TurnEvent
  = | { type: 'text', id: string, delta: string }
    | { type: 'thinking', id: string, delta: string }
    | { type: 'tool-start', id: string, name: string, input: string }
    | { type: 'tool-output', id: string, delta: string }
    | { type: 'tool-end', id: string, output: string, error: boolean }
    | { type: 'approval', id: string, kind: 'command' | 'file' | 'tool', title: string, details: string }
    | { type: 'question', id: string, questions: KernelQuestion[] }
    | { type: 'error', message: string }
    | { type: 'done' }

/** One question a native kernel asks the human. */
export interface KernelQuestion {
  id: string
  question: string
  options?: { label: string, description?: string }[]
  multiSelect?: boolean
}

/** Install progress frames streamed to the full-screen install surface. */
export type InstallEvent
  = | { type: 'step', message: string, percent: number }
    | { type: 'tick', percent: number }
    | { type: 'error', message: string }
    | { type: 'done', version: string | null }
