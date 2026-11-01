import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ReactElement } from 'react'
import type { NativeTurnOptions } from '../../shared/native-model'
import type { KernelBinding } from '../../shared/types'
import type { OfficialModelSelectFace } from '../types/kernel-model'
import type { ModelKernelProps } from './slot-contract'
import { createElement, useEffect, useState, useSyncExternalStore } from 'react'
import { locale } from '../locales'
import { backendFromIdentity, isForkedIdentity } from '../service/kernel-identity'
import { hasModelLockFace } from '../service/kernel-model'
import { isNativeTurnOptions } from '../service/kernel-model.utils'
import { kernelContentAvailable } from '../service/kernel-version'
import { kernelStore } from '../store/modules/kernel-store'
import { useStore } from '../store/reactive'
import { Select } from './select'

export function ModelKernel(props: ModelKernelProps): ReactElement | null {
  return props.Original === undefined
    ? <DirectModelKernel {...props} />
    : <WrappedModelKernel {...props} Original={props.Original} />
}

function WrappedModelKernel(props: ModelKernelProps & { Original: NonNullable<ModelKernelProps['Original']> }): ReactElement {
  const store = useStore(kernelStore)
  if (store.phase === 'ready' && !kernelContentAvailable(store.backends))
    return createElement(props.Original, { ...props })
  if (!hasModelLockFace(props))
    return createElement(props.Original, { ...props })
  return <VerifiedModelKernel {...props} />
}

function DirectModelKernel(props: ModelKernelProps): ReactElement | null {
  locale.useLocale()
  const identity = props.useProjection('bridgeKernel')
  const current = props.useProjection('bridgeModel')
  useEffect(() => {
    if (identity === undefined || (backendFromIdentity(identity) !== 'dsh' && !isNativeTurnOptions(current)))
      void props.ensureProjection(props.sessionId)
  }, [props.ensureProjection, props.sessionId, identity, current])
  const backend = backendFromIdentity(identity)
  if (backend === 'dsh')
    return null
  if ((backend !== 'codex' && backend !== 'claude') || !isNativeTurnOptions(current)
    || isForkedIdentity(identity, props.sessionId) || !props.canSelectNativeModel()) {
    const label = backend === undefined ? locale.text('kernel.label') : locale.text('kernel.modelDefault')
    return (
      <Select
        variant="composerTrigger"
        options={[{ value: label, label }]}
        value={label}
        onChange={() => {}}
        disabled
        title={isForkedIdentity(identity, props.sessionId) ? locale.text('kernel.fork') : locale.text('kernel.pending')}
        data-bridge-kernel-model="locked"
      />
    )
  }
  const binding = identity as KernelBinding
  return <DirectNativeModel key={`${props.sessionId}:${binding.nativeSessionId}`} {...props} binding={binding} current={current} />
}
function DirectNativeModel(props: ModelKernelProps & { binding: KernelBinding, current: NativeTurnOptions }): ReactElement {
  const { sessionId, binding, current } = props
  const [directory] = useState(() => props.createNativeModelDirectory(sessionId, binding, current))
  useEffect(() => {
    props.syncNativeModel(sessionId, binding, current)
  }, [props.syncNativeModel, sessionId, binding.backend, binding.nativeSessionId, current.model, current.reasoningEffort])
  const snapshot = useSyncExternalStore(directory.subscribe, directory.getSnapshot, directory.getSnapshot)
  const modelOptions = snapshot.groups.flatMap(group => group.models.map(model => ({ value: model.id, label: model.name })))
  const currentModel = snapshot.current?.model ?? current.model
  const currentInfo = currentModel === null
    ? undefined
    : snapshot.groups.flatMap(group => group.models).find(model => model.id === currentModel)
  const currentEffort = snapshot.current?.model === currentModel ? snapshot.current?.reasoningEffort : undefined
  const effortOptions = currentInfo?.reasoning?.efforts.map(effort => ({
    value: `${currentModel}\0${effort.id}`,
    label: `${currentInfo.name} · ${effort.name}`,
  })) ?? []
  const retryValue = '\u0000retry'
  const retryOptions = snapshot.status === 'error'
    ? [{ value: retryValue, label: locale.text('kernel.modelRetry') }]
    : []
  const options = [
    ...(currentModel !== null && !modelOptions.some(option => option.value === currentModel) ? [{ value: currentModel, label: currentModel }] : []),
    ...modelOptions,
    ...effortOptions,
    ...retryOptions,
  ]
  const label = locale.text('kernel.modelDefault')
  const value = currentModel === null
    ? options[0]?.value ?? label
    : currentEffort === undefined
      ? currentModel
      : `${currentModel}\0${currentEffort}`
  return (
    <span title={snapshot.error ?? locale.text('kernel.modelNextTurn')} data-bridge-kernel-model="native">
      <Select
        variant="composerTrigger"
        options={options.length > 0 ? options : [{ value: label, label }]}
        value={value}
        onChange={(selected) => {
          if (selected === retryValue) {
            void props.loadNativeModels(sessionId, binding)
            return
          }
          const [model, selectedEffort] = selected.split('\u0000')
          const provider = snapshot.current?.provider ?? `bridge/${binding.backend}`
          const effort = model === snapshot.current?.model ? selectedEffort ?? snapshot.current?.reasoningEffort : selectedEffort
          const selection: ModelSelection = { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
          void props.selectNativeModel(sessionId, binding, selection)
        }}
        disabled={props.locked || !props.canSelectNativeModel()
          || snapshot.status === 'loading' || snapshot.status === 'selecting'
          || (snapshot.routable === null && snapshot.status !== 'error') || options.length === 0}
        data-bridge-kernel-model="native"
      />
    </span>
  )
}

function VerifiedModelKernel(props: ModelKernelProps & OfficialModelSelectFace & { Original: NonNullable<ModelKernelProps['Original']> }): ReactElement {
  locale.useLocale()
  const identity = props.useProjection('bridgeKernel')
  const current = props.useProjection('bridgeModel')
  useEffect(() => {
    if (identity === undefined || (backendFromIdentity(identity) !== 'dsh' && !isNativeTurnOptions(current)))
      void props.ensureProjection(props.sessionId)
  }, [props.ensureProjection, props.sessionId, identity, current])
  const backend = backendFromIdentity(identity)
  if (backend === 'dsh')
    return createElement(props.Original, { ...props })
  if (backend === undefined || !isNativeTurnOptions(current))
    return createElement(props.Original, { ...props, locked: true })
  if (isForkedIdentity(identity, props.sessionId) || !props.canSelectNativeModel())
    return createElement(props.Original, { ...props, locked: true })
  const binding = identity as KernelBinding
  return <NativeOfficialModel key={`${props.sessionId}:${binding.nativeSessionId}`} {...props} binding={binding} current={current} />
}

function NativeOfficialModel(props: ModelKernelProps & OfficialModelSelectFace & {
  Original: NonNullable<ModelKernelProps['Original']>
  binding: KernelBinding
  current: NativeTurnOptions
}): ReactElement {
  const { sessionId, binding, current } = props
  const [directory] = useState(() => props.createNativeModelDirectory(sessionId, binding, current))
  useEffect(() => {
    props.syncNativeModel(sessionId, binding, current)
  }, [props.syncNativeModel, sessionId, binding.backend, binding.nativeSessionId, current.model, current.reasoningEffort])
  return createElement(props.Original, {
    ...props,
    available: props.canSelectNativeModel(),
    directory,
    load: () => { void props.loadNativeModels(sessionId, binding) },
    select: (selection: ModelSelection) => props.selectNativeModel(sessionId, binding, selection),
  })
}
