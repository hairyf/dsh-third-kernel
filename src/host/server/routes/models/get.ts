import type { NativeModelDirectory } from '../../../../shared/native-model'
import { model } from '../../../service/model'
import { asRequestError, RequestError } from '../../request'

export default async function getModels(request: Request): Promise<NativeModelDirectory> {
  const ids = new URL(request.url).searchParams.getAll('sessionId')
  if (ids.length !== 1 || !ids[0]!.trim())
    throw new RequestError('BRIDGE_SESSION_INVALID: 请指定原生会话。')
  try {
    return await model.getCatalog(ids[0]!)
  }
  catch (error) {
    asRequestError(error)
  }
}
