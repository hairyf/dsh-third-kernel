export class RequestError extends Error {}

/**
 * Re-raise a bridge failure that already carries a stable `BRIDGE_*` code as a
 * client error, so the handler's response body keeps the real reason instead of
 * the generic internal message. Anything else keeps its original identity and
 * stays an internal failure.
 */
export function asRequestError(error: unknown): never {
  const message = error instanceof Error ? error.message : ''
  if (!message.startsWith('BRIDGE_'))
    throw error
  throw new RequestError(message)
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await request.json()
  }
  catch {
    throw new RequestError('BRIDGE_REQUEST_INVALID: 请求体必须是 JSON 对象。')
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw new RequestError('BRIDGE_REQUEST_INVALID: 请求体必须是 JSON 对象。')
  return body as Record<string, unknown>
}
