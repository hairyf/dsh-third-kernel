/** Kernel identity, install copy, hero copy, and the official slot keys we decorate. */
import type { KernelId, ThirdPartyKernelId } from '../../shared/protocol'

/** Label and accent for each kernel, shared by the switcher and the install UI. */
export const KERNEL_META = {
  dsh: { label: 'DeepSeek Harness', short: 'DSH', accent: '#4d6bfe' },
  codex: { label: 'Codex', short: 'Codex', accent: '#0a0a0a' },
  claude: { label: 'Claude Code', short: 'Claude', accent: '#c8553d' },
} as const satisfies Record<KernelId, { label: string, short: string, accent: string }>

/** Copy for the full-screen install surface, per kernel. */
export const INSTALL_COPY: Record<ThirdPartyKernelId, { initializing: string, hint: string }> = {
  codex: { initializing: '正在初始化本地 Codex…', hint: '首次安装会下载 OpenAI 官方 Codex CLI 到全局。' },
  claude: { initializing: '正在初始化本地 Claude…', hint: '首次安装会下载 Anthropic 官方 Claude Code CLI 到全局。' },
}

/** Copy for each kernel's own empty conversation view. */
export const HERO_COPY: Record<ThirdPartyKernelId, { title: string, input: string }> = {
  codex: { title: '你想让我们在 {dir} 中构建什么？', input: '随心输入' },
  claude: { title: 'You are here!', input: 'Describe a task or ask a question' },
}

/**
 * Short provider label shown alongside each kernel's mark.
 *
 * Both are Chinese on purpose: the hero headline next to them is 官方中文
 * （探索未至之境），an English slogan would read as a different product. Kept to
 * six glyphs so the 26px headline row never wraps on a narrow window.
 */
export const KERNEL_SLOGAN: Record<ThirdPartyKernelId, string> = {
  codex: 'Codex 内核',
  claude: 'Claude 内核',
}

export const HERO_AGENT_PRESET_SLOT = 'conversation.hero.agentPreset'
export const KERNEL_HERO_BRAND_SLOT = 'conversation.hero.brand.mark'
export const KERNEL_LINEAGE_SLOT = 'conversation.session.header.lineage'
export const MODEL_KERNEL_SLOT = 'conversation.input.model'
export const NATIVE_DEFAULT_MODEL = ''
export const SIDEBAR_KERNEL_SLOT = 'sidebar.session.row.leading'
export const SIDEBAR_KERNEL_HOVER_SLOT = 'sidebar.session.row.hover'
