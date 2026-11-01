import type { Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'

export type ClientContext = Omit<Context, 'sessions'> & { sessions: ISessions }
export type SessionCreateOptions = NonNullable<Parameters<ISessions['create']>[0]>
export type { ISessions, SessionListState }
export type { SessionId } from '@deepseek-ai/dsh-session'
