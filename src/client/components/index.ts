/**
 * 客户端 UI 表现层：组合官方 primitives 与本项目的 slot helpers。
 *
 * 只留内核槽位真正消费的部分：`registerSlotDecoration`（装饰官方渲染体而不是抢占槽位）、
 * 厂商图标（Codex/Claude mark）、Chip/Select 触发器与图标字形。上游整套 css-render
 * 设计系统与桌面壳自有面板不 vendor。
 */
export * from './brand-icons'
export * from './chip'
export * from './icon'
export * from './icons'
export * from './select'
export * from './slot-decoration'
export { FishLogo, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
