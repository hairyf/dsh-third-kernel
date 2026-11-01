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
  models: `${API_PREFIX}/models`,
  turn: `${API_PREFIX}/turn`,
  answer: `${API_PREFIX}/answer`,
  interrupt: `${API_PREFIX}/interrupt`,
  close: `${API_PREFIX}/close`,
  browse: `${API_PREFIX}/browse`,
} as const

/** One row of a directory listing. */
export interface BrowseEntry {
  name: string
  path: string
}

/**
 * A directory listing for the project picker.
 *
 * `parent` is null at a filesystem root; `roots` is non-empty only when no path
 * was requested, so the picker can offer drives on Windows without guessing.
 */
export interface BrowseListing {
  path: string
  parent: string | null
  dirs: BrowseEntry[]
  roots?: BrowseEntry[]
  error?: string
}

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

/**
 * One selectable model, normalised from both native catalogues.
 *
 * Codex reports `{ model, supportedReasoningEfforts }`; Claude reports
 * `{ displayName, supportedEffortLevels }`. The composer needs the same shape
 * from both, so the adapters flatten them here rather than the UI sniffing
 * kernel-specific strings.
 */
export interface KernelModel {
  /** Wire id handed back on the next turn. */
  id: string
  /** What the composer shows. */
  label: string
  /** Reasoning levels this model accepts, already human-readable. */
  efforts: KernelEffort[]
}

export interface KernelEffort {
  /** Wire id (`low`, `xhigh`, …). */
  id: string
  label: string
}

/**
 * How much the kernel may do without asking.
 *
 * Both CLIs express this natively — Codex as `approvalPolicy` + `sandboxPolicy`,
 * Claude as `--permission-mode` — so the mode is applied at turn or process
 * start rather than simulated in the UI.
 */
export const PERMISSION_MODES = ['read-only', 'auto', 'full-access'] as const

export type PermissionMode = (typeof PERMISSION_MODES)[number]

/** Per-turn knobs the composer owns. */
export interface TurnOptions {
  model?: string
  effort?: string
  permission: PermissionMode
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
