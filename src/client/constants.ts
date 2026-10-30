/** Kernel identity and the switcher's persisted selection. */
import type { KernelId, ThirdPartyKernelId } from '../shared/protocol'

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
  claude: { title: 'You are here!', input: 'How can I help you today?' },
}

/** Attribute marking the plugin's own DOM, so styles can be scoped. */
export const ROOT_ATTRIBUTE = 'data-dsh-third-kernel'
