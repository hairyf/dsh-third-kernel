import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutor } from '@deepseek-ai/dsh-tools'
import type { z } from 'zod'
import type { PlatformLoader, RuntimeModules } from '../types'

/** Official native executor constructor, installed into a bridged agent scope. */
export interface NativeToolExecutorClass {
  new (ctx: Context, maxParallel?: () => number): ToolExecutor
}

/**
 * DSH 0.2.2 replaced `tools.presentAs('native')` with executor selection:
 * `tools.setExecutor(...)` is the one per-scope provider. Bridged sessions feed
 * native tool calls into the official pipeline as model-direct calls, which a
 * PTC presentation would reject as `UNKNOWN_TOOL`, so the scope must select the
 * official native executor for the duration of the native turn.
 */
export async function loadNativeExecutor(loader: PlatformLoader): Promise<NativeToolExecutorClass> {
  const module = await loader.import('@deepseek-ai/dsh-tool-executor-native')
  const direct = (module as { NativeToolExecutor?: unknown } | null)?.NativeToolExecutor
  const resolved = direct ?? (loader.unwrapExports(module) as { NativeToolExecutor?: unknown } | null)?.NativeToolExecutor
  if (typeof resolved !== 'function')
    throw new TypeError('BRIDGE_RUNTIME_EXPORT_MISSING: @deepseek-ai/dsh-tool-executor-native.NativeToolExecutor')
  return resolved as NativeToolExecutorClass
}

/** Public pipeline used for executor-owned native replay capabilities. */
export async function loadToolPipeline(loader: PlatformLoader): Promise<typeof import('@deepseek-ai/dsh-tools/pipeline')> {
  const module = await loader.import('@deepseek-ai/dsh-tools/pipeline')
  const resolved = (module as typeof import('@deepseek-ai/dsh-tools/pipeline'))?.ToolExecutionPipeline ? module : loader.unwrapExports(module)
  const pipeline = resolved as typeof import('@deepseek-ai/dsh-tools/pipeline')
  if (typeof pipeline?.ToolExecutionPipeline !== 'function' || typeof pipeline.executeToolBatch !== 'function')
    throw new TypeError('BRIDGE_RUNTIME_EXPORT_MISSING: @deepseek-ai/dsh-tools/pipeline')
  return pipeline
}

export async function loadRuntimeZod(loader: PlatformLoader): Promise<typeof z> {
  const value = await loader.import('zod')
  const direct = (value as { z?: typeof z } | null)?.z
  const resolved = direct ?? (loader.unwrapExports(value) as { z?: typeof z } | null)?.z
  if (typeof resolved?.object !== 'function' || typeof resolved.string !== 'function' || typeof resolved.enum !== 'function' || typeof resolved.number !== 'function' || typeof resolved.array !== 'function')
    throw new TypeError('BRIDGE_RUNTIME_EXPORT_MISSING: zod.z')
  return resolved
}

/**
 * The runtime exports this plugin contracts on. Every one of them is part of
 * the pinned core line, so a missing export is a hard `BRIDGE_CORE_UNAVAILABLE`
 * — never a silent degraded mode on an older core.
 */
export async function loadRuntimeModules(loader: PlatformLoader): Promise<Required<RuntimeModules>> {
  const [llm, session] = await Promise.all([loader.import('@deepseek-ai/dsh-llm'), loader.import('@deepseek-ai/dsh-session')])
  return {
    ToolCallId: resolveExport(loader, llm, 'ToolCallId'),
    LlmAdapter: resolveExport(loader, llm, 'LlmAdapter'),
    isAgentLoopRequest: resolveExport(loader, llm, 'isAgentLoopRequest'),
    appendPluginRecord: resolveExport(loader, session, 'appendPluginRecord'),
    pluginRecordOf: resolveExport(loader, session, 'pluginRecordOf'),
  }
}

function optionalExport<K extends keyof RuntimeModules>(loader: PlatformLoader, value: unknown, key: K): RuntimeModules[K] | undefined {
  const direct = (value as Partial<RuntimeModules> | null)?.[key]
  if (typeof direct === 'function')
    return direct as RuntimeModules[K]
  const fallback = (loader.unwrapExports(value) as Partial<RuntimeModules> | null)?.[key]
  return typeof fallback === 'function' ? fallback as RuntimeModules[K] : undefined
}

function resolveExport<K extends keyof RuntimeModules>(loader: PlatformLoader, value: unknown, key: K): NonNullable<RuntimeModules[K]> {
  const value_ = optionalExport(loader, value, key)
  if (value_ === undefined)
    throw new TypeError(`BRIDGE_RUNTIME_EXPORT_MISSING: ${key}`)
  return value_ as NonNullable<RuntimeModules[K]>
}
