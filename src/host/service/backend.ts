import type { BackendDetection } from '../../shared/types'
import type { DetectedCommand } from '../utils/detection'
import { KERNEL_CORE_BASELINE, kernelVersionAtLeast } from '../../shared/version'
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
      await loadRuntimeModules(ctx.loader)
      if (!runtime.ready || typeof ctx.sessions.get !== 'function' || typeof ctx.agents.turnBoundaryOf !== 'function')
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
    const version = await runtimeVersion(ctx.loader)
    // `package.json` pins the supported core line through peerDependencies, and
    // this report turns a manually overridden install into a visible refusal
    // instead of a half-working bridge on an API the plugin no longer targets.
    const supported = kernelVersionAtLeast(version)
    return [{
      id: 'dsh',
      installed: true,
      auth: 'ok',
      version,
      drift: supported === false,
      hint: supported === false ? `BRIDGE_CORE_UNSUPPORTED: 需要 DSH ${KERNEL_CORE_BASELINE} 或更新的核心。` : null,
    }, ...results.map(result => result.detection)]
  },
}
