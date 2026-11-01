export class RequestError extends Error {}

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
