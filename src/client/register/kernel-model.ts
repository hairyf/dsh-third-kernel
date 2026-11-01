import type { KernelBinding } from '../../shared/types'
import type { LifecycleController } from '../lib/lifecycle'
import type { ClientContext, SessionId } from '../types/client'
import type { NativeModelActions, NativeModelScope } from '../types/kernel-model'
import { noop, sameKernelBinding, sameTurnOptions } from '../lib/utils'
import { loadNativeModels, selectNativeModel } from '../service/kernel-model'
import { isNativeTurnOptions, nativeModelDirectory } from '../service/kernel-model.utils'
import { nativeModel } from '../store/modules/native-model'

export function registerNativeModels(controller: LifecycleController, ctx: ClientContext): NativeModelActions {
  const scopes = new Map<string, { scope: number, backend: KernelBinding['backend'], nativeSessionId: string, references: number }>()
  const canSelectNativeModel = (): boolean => !controller.isDisposed()
  const scopeOf = (sessionId: string, binding: KernelBinding): NativeModelScope | undefined => {
    const lease = scopes.get(sessionId)
    return canSelectNativeModel() && binding.sessionId === sessionId && lease?.backend === binding.backend
      && lease.nativeSessionId === binding.nativeSessionId
      ? { sessionId, scope: lease.scope, active: () => !controller.isDisposed() && scopes.get(sessionId) === lease && lease.references > 0 }
      : undefined
  }
  controller.add(() => {
    for (const [sessionId, lease] of scopes)
      nativeModel.close(sessionId, lease.scope)
    scopes.clear()
  })
  const actions: NativeModelActions = {
    canSelectNativeModel,
    createNativeModelDirectory(sessionId, binding, current) {
      const initial = nativeModelDirectory(binding.backend, current, null)
      return {
        getSnapshot: () => {
          const entry = nativeModel.getSnapshot().entries[sessionId]
          return scopeOf(sessionId, binding) === undefined ? initial : entry?.directory ?? initial
        },
        subscribe(listener) {
          if (!canSelectNativeModel() || binding.sessionId !== sessionId)
            return noop
          const release = actions.acquireNativeModel(sessionId, binding)
          const state = ctx.sessions.list.getSnapshot()
          const values = state.projectionsBySession?.[sessionId as SessionId]?.values ?? state.byId[sessionId as SessionId]?.projectionValues
          const latest = sameKernelBinding(values?.bridgeKernel, binding) && isNativeTurnOptions(values?.bridgeModel) ? values.bridgeModel : current
          actions.syncNativeModel(sessionId, binding, latest)
          const unsubscribe = nativeModel.subscribe(listener)
          const scope = scopeOf(sessionId, binding)
          queueMicrotask(() => {
            const entry = nativeModel.getSnapshot().entries[sessionId]
            if (scope?.active() && entry?.scope === scope.scope && entry.request === 0)
              void loadNativeModels(scope)
          })
          let stopped = false
          const dispose = (): void => {
            if (stopped)
              return
            stopped = true
            unsubscribe()
            release()
          }
          const unhook = controller.add(dispose)
          return () => {
            dispose()
            unhook()
          }
        },
      }
    },
    acquireNativeModel(sessionId, binding) {
      if (!canSelectNativeModel() || binding.sessionId !== sessionId)
        return noop
      let lease = scopes.get(sessionId)
      if (lease === undefined || lease.backend !== binding.backend || lease.nativeSessionId !== binding.nativeSessionId) {
        const current = { model: null, reasoningEffort: null }
        lease = { scope: nativeModel.nextScope(), backend: binding.backend, nativeSessionId: binding.nativeSessionId, references: 0 }
        scopes.set(sessionId, lease)
        nativeModel.open({ ...lease, sessionId, backend: binding.backend, request: 0, catalog: null, current, directory: nativeModelDirectory(binding.backend, current, null) })
      }
      lease.references += 1
      const owned = lease
      let released = false
      return () => {
        if (released || scopes.get(sessionId) !== owned)
          return
        released = true
        if (--owned.references === 0) {
          queueMicrotask(() => {
            if (scopes.get(sessionId) !== owned || owned.references !== 0)
              return
            scopes.delete(sessionId)
            nativeModel.close(sessionId, owned.scope)
          })
        }
      }
    },
    syncNativeModel(sessionId, binding, current) {
      const scope = scopeOf(sessionId, binding)
      const entry = nativeModel.getSnapshot().entries[sessionId]
      if (scope === undefined || entry === undefined || sameTurnOptions(entry.current, current))
        return
      nativeModel.update(sessionId, scope.scope, { current, directory: nativeModelDirectory(entry.backend, current, entry.catalog, entry.directory) })
    },
    async loadNativeModels(sessionId, binding) {
      const scope = scopeOf(sessionId, binding)
      if (scope !== undefined)
        await loadNativeModels(scope)
    },
    async selectNativeModel(sessionId, binding, selection) {
      const scope = scopeOf(sessionId, binding)
      if (scope === undefined)
        return undefined
      return selectNativeModel({
        ...scope,
        selection,
        async refreshProjection(id) {
          if (controller.isDisposed() || !scope.active())
            throw new Error('Native model selection scope is unavailable')
          await ctx.sessions.refreshProjections(id as SessionId)
          if (controller.isDisposed() || !scope.active())
            throw new Error('Native model selection scope is unavailable')
          const state = ctx.sessions.list.getSnapshot()
          const values = state.projectionsBySession?.[id as SessionId]?.values ?? state.byId[id as SessionId]?.projectionValues
          if (!sameKernelBinding(values?.bridgeKernel, binding) || !isNativeTurnOptions(values?.bridgeModel))
            throw new Error('Native model selection projection is unavailable')
          return values.bridgeModel
        },
      })
    },
  }
  return actions
}
