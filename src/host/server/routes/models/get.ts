import type { NativeModelDirectory } from '../../../../shared/native-model'
import { model } from '../../../service/model'
import { RequestError } from '../../request'

export default function getModels(request: Request): Promise<NativeModelDirectory> {
  const ids = new URL(request.url).searchParams.getAll('sessionId')
  if (ids.length !== 1 || !ids[0]!.trim())
    throw new RequestError('BRIDGE_SESSION_INVALID: 请指定原生会话。')
  return model.getCatalog(ids[0]!)
}
