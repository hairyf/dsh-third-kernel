import type { DependencyList, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'

export function If({ cond, then, else: otherwise, children }: {
  cond?: unknown
  then?: ReactNode
  else?: ReactNode
  children?: ReactNode
}): ReactNode {
  return cond ? then ?? children : otherwise
}

export function useWatchImmediate<T>(value: T, callback: (value: T) => void): void {
  const deps = Array.isArray(value) ? value : [value]
  useEffect(() => callback(value), deps as DependencyList)
}

export function useAsyncState<A extends readonly unknown[], R>(
  action: (...args: A) => Promise<R>,
  initialState: unknown = undefined,
  options: { immediate?: boolean, onSuccess?: (value: R) => void } = {},
): {
  isLoading: boolean
  error: unknown
  executeImmediate: (...args: A) => Promise<R | undefined>
} {
  void initialState
  const [isLoading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const executeImmediate = useCallback(async (...args: A): Promise<R | undefined> => {
    setLoading(true)
    setError(null)
    try {
      const value = await action(...args)
      options.onSuccess?.(value)
      return value
    }
    catch (reason) {
      setError(reason)
      return undefined
    }
    finally {
      setLoading(false)
    }
  }, [action, options.onSuccess])
  useEffect(() => {
    if (options.immediate)
      void executeImmediate(...([] as unknown as A))
  }, [executeImmediate, options.immediate])
  return { isLoading, error, executeImmediate }
}
