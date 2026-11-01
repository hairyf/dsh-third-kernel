import type { BackendDetection } from '../../shared/types'
import type { DetectedCommand } from '../utils/detection'
import { runtime } from '../config/runtime'
import { getHostConfig, getHostContext } from '../context'
import { detectBackend } from '../utils/detection'
import { loadRuntimeModules } from '../utils/runtime-modules'
import { runtimeVersion } from '../utils/runtime-version'

export const backend = {
  async resolve(id: 'codex' | 'claude'): Promise<DetectedCommand> {
    const ctx = getHostContext()
    const config = getHostConfig()
    const result = await detectBackend(id, id === 'codex' ? config.codexPath : config.claudePath, { timeoutMs: config.probeTimeoutMs })
    try {
      const modules = await loadRuntimeModules(ctx.loader)
      if (!runtime.ready || typeof modules.appendPluginRecord !== 'function' || typeof modules.pluginRecordOf !== 'function' || typeof ctx.sessions.get !== 'function' || typeof ctx.sessionProjections.stateOf !== 'function')
        throw new Error('BRIDGE_CORE_UNAVAILABLE: 当前核心未提供完整的官方内核桥接接口。')
      runtime.lifetime.signal.throwIfAborted()
      result.detection.bridgeReady = true
    }
    catch {
      result.detection.bridgeReady = false
      if (result.detection.installed)
        result.detection.hint = 'BRIDGE_CORE_UNAVAILABLE: 当前核心未提供完整的官方内核桥接接口，不能连接本机 CLI。'
      delete result.command
    }
    if (!runtime.lifetime.signal.aborted)
      runtime.detections.set(id, result.detection)
    return result
  },

  async getCatalog(): Promise<BackendDetection[]> {
    const ctx = getHostContext()
    const results = await Promise.all([backend.resolve('codex'), backend.resolve('claude')])
    return [{ id: 'dsh', installed: true, auth: 'ok', version: await runtimeVersion(ctx.loader), drift: false, hint: null }, ...results.map(result => result.detection)]
  },
}
