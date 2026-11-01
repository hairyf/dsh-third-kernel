import { session } from '../../../service/session'
import { readBody, RequestError } from '../../request'

export default async function postSessions(request: Request): Promise<{ sessionId: string }> {
  const body = await readBody(request)
  if (body.backend !== 'codex' && body.backend !== 'claude')
    throw new RequestError('BRIDGE_BACKEND_INVALID: 请选择 Codex 或 Claude。')
  for (const key of ['workspaceId', 'cwd', 'agentPreset'] as const) {
    if (body[key] !== undefined && (typeof body[key] !== 'string' || !body[key].trim()))
      throw new RequestError(`BRIDGE_REQUEST_INVALID: ${key}`)
  }
  if (body.workspaceId !== undefined && body.cwd !== undefined)
    throw new RequestError('BRIDGE_LOCATION_INVALID: workspaceId 与 cwd 不能同时指定。')
  try {
    return await session.create(body.backend, body.workspaceId as string | undefined, body.cwd as string | undefined, body.agentPreset as string | undefined)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (!message.startsWith('BRIDGE_'))
      throw error
    throw new RequestError(message)
  }
}
