import type { ReactElement } from 'react'
import type { BackendId } from '../../shared/types'
import { If } from '../lib/hooks'
import { ClaudeIcon, FishLogo, GptIcon } from './index'

export function KernelIcon({ backend, size = 16, color }: { backend: BackendId | undefined, size?: number, color?: string }): ReactElement {
  return (
    <>
      <If cond={backend === 'codex'} then={<GptIcon width={size} height={size} color={color} />} />
      <If cond={backend === 'claude'} then={<ClaudeIcon width={size} height={size} color={color} />} />
      <If cond={backend === 'dsh'} then={<FishLogo size={size} />} />
    </>
  )
}
