import type { Config } from './config/options'
import type { HostContext } from './types'

// ponytail: one active plugin per module; use per-instance services if isolation is needed.
let owner: { ctx: HostContext, config: Config } | undefined

export function activateHost(ctx: HostContext, config: Config): () => void {
  if (owner)
    throw new Error('BRIDGE_OWNER_CONFLICT: 原生桥接已激活。')
  const current = { ctx, config }
  owner = current
  return () => {
    if (owner === current)
      owner = undefined
  }
}

export function getHostContext(): HostContext {
  if (!owner)
    throw new Error('BRIDGE_DISPOSED: 原生桥接未激活。')
  return owner.ctx
}

export function getHostConfig(): Config {
  if (!owner)
    throw new Error('BRIDGE_DISPOSED: 原生桥接未激活。')
  return owner.config
}
