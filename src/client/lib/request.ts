export interface FetchOptions extends Omit<RequestInit, 'body'> {
  params?: Record<string, string | number | boolean | null | undefined>
  body?: unknown
}

function parse(text: string): unknown {
  if (text.length === 0)
    return undefined
  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
}

function errorMessage(status: number, body: unknown): string {
  const text = typeof body === 'string'
    ? body
    : body !== null && typeof body === 'object'
      ? ['error', 'message', 'statusMessage'].map(key => (body as Record<string, unknown>)[key]).find(value => typeof value === 'string' && value.length > 0) as string | undefined
      : undefined
  return text === undefined ? `请求失败 (${status})` : `请求失败 (${status}): ${text}`
}

export async function request<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const target = new URL(url, typeof window === 'undefined' ? 'http://localhost' : window.location.href)
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value !== undefined && value !== null)
      target.searchParams.set(key, String(value))
  }
  const headers = new Headers(options.headers)
  let body = options.body
  if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof ArrayBuffer) && !(body instanceof Blob) && !(body instanceof FormData)) {
    if (!headers.has('content-type'))
      headers.set('content-type', 'application/json')
    body = JSON.stringify(body)
  }
  const response = await fetch(target.href, { ...options, body: body as BodyInit | null | undefined, headers })
  const parsed = parse(await response.text())
  if (!response.ok)
    throw Object.assign(new Error(errorMessage(response.status, parsed)), { status: response.status, data: parsed })
  return parsed as T
}

export const ofetch = request
