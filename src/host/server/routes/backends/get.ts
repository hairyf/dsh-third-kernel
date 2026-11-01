import type { BackendDetection } from '../../../../shared/types'
import { backend } from '../../../service/backend'

export default function getBackends(): Promise<BackendDetection[]> {
  return backend.getCatalog()
}
