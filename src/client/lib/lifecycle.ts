export interface LifecycleController {
  add: (dispose: () => void) => () => void
  timeout: (callback: () => void, ms: number) => () => void
  isDisposed: () => boolean
  dispose: () => void
}

export function createLifecycleController(): LifecycleController {
  let disposed = false
  const disposers = new Set<() => void>()
  const safely = (dispose: () => void): void => {
    try {
      dispose()
    }
    catch (error) {
      console.error('Kernel resource disposal failed', error)
    }
  }
  const controller: LifecycleController = {
    add(dispose) {
      if (disposed) {
        safely(dispose)
        return () => {}
      }
      disposers.add(dispose)
      return () => {
        disposers.delete(dispose)
      }
    },
    timeout(callback, ms) {
      if (disposed)
        return () => {}
      const timer = setTimeout(() => {
        if (!disposed)
          callback()
      }, ms)
      const cancel = (): void => clearTimeout(timer)
      const unhook = controller.add(cancel)
      return () => {
        cancel()
        unhook()
      }
    },
    isDisposed: () => disposed,
    dispose() {
      if (disposed)
        return
      disposed = true
      for (const dispose of [...disposers])
        safely(dispose)
      disposers.clear()
    },
  }
  return controller
}
