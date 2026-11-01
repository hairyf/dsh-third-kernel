/**
 * Typed browser client for the kernel API.
 *
 * The streams are newline-delimited JSON, so each helper takes an
 * `AbortSignal` and yields parsed events. All errors surface as thrown
 * `KernelApiError` with the host's message intact.
 */
import type { InstallEvent, KernelModel, KernelState, ThirdPartyKernelId, TurnEvent, TurnOptions } from '../../shared/protocol'
import { ROUTES } from '../../shared/protocol'

export class KernelApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'KernelApiError'
  }
}

async function failure(response: Response): Promise<KernelApiError> {
  const detail = await response.json().catch(() => undefined) as { error?: unknown } | undefined
  return new KernelApiError(typeof detail?.error === 'string' ? detail.error : `请求失败（${response.status}）`, response.status)
}

/** Parse one newline-delimited JSON response into typed events. */
async function* frames<T>(response: Response): AsyncGenerator<T> {
  if (response.body === null)
    return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done)
        break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line !== '')
          yield JSON.parse(line) as T
      }
    }
    const tail = buffer.trim()
    if (tail !== '')
      yield JSON.parse(tail) as T
  }
  finally {
    reader.releaseLock()
  }
}

async function post(path: string, payload: unknown, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  if (!response.ok)
    throw await failure(response)
  return response
}

/** Detection rows and the host's default working directory. */
export async function fetchState(signal?: AbortSignal): Promise<{ kernels: KernelState[], cwd: string }> {
  const response = await fetch(ROUTES.state, { credentials: 'same-origin', signal })
  if (!response.ok)
    throw await failure(response)
  return await response.json() as { kernels: KernelState[], cwd: string }
}

/** Install one kernel, streaming phase progress until it settles. */
export async function* install(kernel: ThirdPartyKernelId, signal: AbortSignal): AsyncGenerator<InstallEvent> {
  const response = await post(ROUTES.install, { kernel }, signal)
  yield* frames<InstallEvent>(response)
}

export interface OpenedSession {
  id: string
  kernel: ThirdPartyKernelId
  cwd: string
  models: KernelModel[]
}

/** Start a kernel conversation. */
export async function openSession(kernel: ThirdPartyKernelId, cwd: string, signal?: AbortSignal): Promise<OpenedSession> {
  const response = await post(ROUTES.session, { kernel, cwd }, signal)
  return await response.json() as OpenedSession
}

/**
 * Read one kernel's model catalogue.
 *
 * Separate from {@link openSession} on purpose: the composer needs the list on
 * arrival, before any conversation exists, so the host answers this from a
 * short-lived handshake that is disposed before the response is written.
 */
export async function fetchModels(kernel: ThirdPartyKernelId, cwd: string, signal?: AbortSignal): Promise<KernelModel[]> {
  const response = await post(ROUTES.models, { kernel, cwd }, signal)
  const payload = await response.json() as { models?: KernelModel[] }
  return Array.isArray(payload.models) ? payload.models : []
}

/**
 * Run one turn, streaming its events.
 * `options` is sent as `{ options: { … } }` — the shape the host's turn route
 * reads — and omitted entirely when absent.
 */
export async function* runTurn(id: string, text: string, signal: AbortSignal, options?: TurnOptions): AsyncGenerator<TurnEvent> {
  const response = await post(ROUTES.turn, options === undefined ? { id, text } : { id, text, options }, signal)
  yield* frames<TurnEvent>(response)
}

/** Settle one approval or question. */
export async function answer(id: string, requestId: string, value: { allowed: boolean } | { answers: Record<string, string | string[]> }): Promise<void> {
  await post(ROUTES.answer, { id, requestId, ...value })
}

/** Ask the kernel to stop the running turn. */
export async function interrupt(id: string): Promise<void> {
  await post(ROUTES.interrupt, { id })
}

/** Release one kernel conversation. */
export async function closeSession(id: string): Promise<void> {
  await post(ROUTES.close, { id }).catch(() => {})
}
