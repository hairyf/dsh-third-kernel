import type { BackendId } from '../../shared/types'
import type { ClientContext, SessionCreateOptions, SessionId } from '../types/client'
import { postSessions } from '../apis'
import { kernelStore } from '../store/modules/kernel-store'
import { backendFromIdentity, isBackendAvailable, kernelFromList } from './kernel-identity'

export async function createKernelSession(
  ctx: ClientContext,
  backend: BackendId,
  options: SessionCreateOptions,
  active: () => boolean,
  agentPreset?: string,
): Promise<string> {
  if (!active())
    throw new Error('Kernel session creation was cancelled')
  if (options.sessionId !== undefined)
    throw new Error('Existing sessions cannot change kernels')
  if (options.workspaceId !== undefined && options.cwd !== undefined)
    throw new Error('Session creation requires either workspaceId or cwd')
  if (backend === 'dsh') {
    return ctx.sessions.create({ ...options, ...(agentPreset === undefined ? {} : { agentPreset }) })
  }
  const state = kernelStore.getSnapshot()
  const detection = state.backends.find(item => item.id === backend)
  if (state.phase !== 'ready' || !isBackendAvailable(detection))
    throw new Error('The selected native kernel is unavailable')
  const response = await postSessions({
    backend,
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(agentPreset === undefined ? {} : { agentPreset }),
  })
  if (typeof response.sessionId !== 'string' || response.sessionId.trim() === '')
    throw new Error('Native kernel creation returned no session identity')
  if (!active())
    throw new Error('Kernel session creation was cancelled')
  await ctx.sessions.refresh()
  if (!active())
    throw new Error('Kernel session creation was cancelled')
  await ctx.sessions.refreshProjections(response.sessionId as SessionId)
  if (!active())
    throw new Error('Kernel session creation was cancelled')
  const identity = kernelFromList(ctx.sessions.list.getSnapshot(), response.sessionId as SessionId)
  if (backendFromIdentity(identity) !== backend || identity?.sessionId !== response.sessionId)
    throw new Error('The new session has no verified native kernel binding')
  return response.sessionId
}
