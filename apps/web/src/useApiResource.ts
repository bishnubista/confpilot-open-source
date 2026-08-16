import { type DependencyList, useCallback, useEffect, useState } from 'react'

export type ResourceState<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'success'; data: T; error: null }
  | { status: 'error'; data: null; error: Error }

export function useApiResource<T>(loader: (signal: AbortSignal) => Promise<T>, dependencies: DependencyList) {
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<ResourceState<T>>({ status: 'loading', data: null, error: null })
  const reload = useCallback(() => setRevision((value) => value + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading', data: null, error: null })
    loader(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: 'success', data, error: null })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', data: null, error: error instanceof Error ? error : new Error('Request failed') })
      },
    )
    return () => controller.abort()
    // The caller owns the dependency list, matching React's effect contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, revision])

  return { ...state, reload }
}
