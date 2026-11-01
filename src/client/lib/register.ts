import type { ClientContext } from '../types/client'
import type { LifecycleController } from './lifecycle'
import { createLifecycleController } from './lifecycle'

function contextOf(value: unknown): ClientContext {
  if (value !== null && typeof value === 'object' && 'ctx' in value)
    return (value as { ctx: ClientContext }).ctx
  return value as ClientContext
}

export function defineRegister(setup: (controller: LifecycleController, ctx: ClientContext) => void): (this: unknown) => () => void {
  return function register(this: unknown): () => void {
    const controller = createLifecycleController()
    try {
      setup(controller, contextOf(this))
    }
    catch (error) {
      controller.dispose()
      throw error
    }
    return () => controller.dispose()
  }
}
