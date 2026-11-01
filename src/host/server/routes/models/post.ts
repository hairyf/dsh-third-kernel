import type { NativeTurnOptions } from '../../../../shared/native-model'
import { model } from '../../../service/model'
import { readBody, RequestError } from '../../request'

export default async function postModels(request: Request): Promise<NativeTurnOptions> {
  const body = await readBody(request)
  if (typeof body.sessionId !== 'string' || !body.sessionId.trim())
    throw new RequestError('BRIDGE_SESSION_INVALID: 请指定原生会话。')
  for (const key of ['model', 'reasoningEffort'] as const) {
    if (body[key] !== null && (typeof body[key] !== 'string' || !body[key].trim()))
      throw new RequestError(`BRIDGE_MODEL_INVALID: ${key}`)
  }
  return model.select(body.sessionId, { model: body.model as string | null, reasoningEffort: body.reasoningEffort as string | null })
}
