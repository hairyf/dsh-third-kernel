import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { useSyncExternalStore } from 'react'
import { PLUGIN_ID } from '../../shared/constants'

const dictionaries = {
  zh: {
    'kernel.label': '内核',
    'kernel.pending': '正在读取会话内核',
    'kernel.unavailable': '不可用',
    'kernel.coreUnavailable': '核心不支持桥接',
    'kernel.authMissing': '未登录',
    'kernel.authUnknown': '登录状态未知',
    'kernel.drift': '协议不兼容',
    'kernel.newSession': '新建 {backend} 会话',
    'kernel.createFailed': '新建内核会话失败',
    'kernel.readFailed': '内核检测失败',
    'kernel.fork': '派生会话不能继续原生内核',
    'kernel.creating': '正在新建会话',
    'kernel.retry': '重新检测',
    'kernel.selectorScope': '选择会新建会话，仅记住此选择器的下次选择，不更改当前会话或官方新建快捷键',
    'kernel.immutable': '此会话已绑定原生内核，不能更换内核',
    'kernel.modelNextTurn': '模型与推理深度仅影响下一完整轮次，不能更换此会话内核',
    'kernel.modelRetry': '重新加载模型',
    'kernel.modelDefault': '原生默认',
    'kernel.select': '选择内核',
    'kernel.clear': '清空内核选择',
  },
  en: {
    'kernel.label': 'Kernel',
    'kernel.pending': 'Reading session kernel',
    'kernel.unavailable': 'Unavailable',
    'kernel.coreUnavailable': 'Bridge unavailable',
    'kernel.authMissing': 'Not signed in',
    'kernel.authUnknown': 'Sign-in status unknown',
    'kernel.drift': 'Incompatible protocol',
    'kernel.newSession': 'New {backend} session',
    'kernel.createFailed': 'Failed to create kernel session',
    'kernel.readFailed': 'Kernel detection failed',
    'kernel.fork': 'Forked sessions cannot resume the native kernel',
    'kernel.creating': 'Creating a session',
    'kernel.retry': 'Detect again',
    'kernel.selectorScope': 'Selection creates a new session and is remembered for this picker only; it does not change the current session or official new-session shortcuts',
    'kernel.immutable': 'This session is bound to a native kernel; its kernel cannot be changed',
    'kernel.modelNextTurn': 'Model and reasoning changes apply to the next complete turn; this session kernel cannot be changed',
    'kernel.modelRetry': 'Reload models',
    'kernel.modelDefault': 'Native default',
    'kernel.select': 'Select kernel',
    'kernel.clear': 'Clear kernel selection',
  },
} as const

type Key = keyof typeof dictionaries.en
let translate: ((key: Key, params?: Record<string, unknown>) => string) | undefined
let runtime: LocaleRuntime | undefined

function interpolate(value: string, params?: Record<string, unknown>): string {
  return params === undefined ? value : value.replace(/\{(\w+)\}/g, (match, key: string) => key in params ? String(params[key]) : match)
}

function active(): string {
  return runtime?.getLocale().active ?? 'en'
}
function text(key: Key, params?: Record<string, unknown>): string {
  if (translate !== undefined)
    return translate(key, params)
  const dict = active().toLowerCase().startsWith('zh') ? dictionaries.zh : dictionaries.en
  return interpolate(dict[key] ?? dictionaries.en[key] ?? key, params)
}

function subscribe(listener: () => void): () => void {
  return runtime?.subscribe(listener) ?? (() => {})
}

export const locale = {
  NS: PLUGIN_ID,
  text,
  activeLocale: active,
  isEnglishLocale: () => !active().toLowerCase().startsWith('zh'),
  useLocale: () => useSyncExternalStore(subscribe, active, active),
  registerLocale(this: unknown, context?: { locale: LocaleRuntime }): () => void {
    const self = this as { ctx?: { locale?: LocaleRuntime } } | undefined
    const current = context?.locale ?? self?.ctx?.locale
    if (current === undefined)
      throw new TypeError('locale context is unavailable')
    runtime = current
    translate = current.bind(PLUGIN_ID) as typeof translate
    const unregister = current.register(PLUGIN_ID, 'zh', dictionaries.zh)
    const unregisterEn = current.register(PLUGIN_ID, 'en', dictionaries.en)
    return () => {
      unregister()
      unregisterEn()
      if (runtime === current) {
        runtime = undefined
        translate = undefined
      }
    }
  },
}
