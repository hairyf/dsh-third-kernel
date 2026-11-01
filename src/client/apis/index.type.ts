export type GetApiTauriBridgeBackendsResponse = { id: 'codex' | 'claude' | 'dsh', installed: false | true, bridgeReady?: undefined | false | true, auth: 'ok' | 'missing' | 'unknown', version: null | string, drift: false | true, hint: null | string }[]
export interface GetApiTauriBridgeModelsResponse { backend: 'codex' | 'claude', current: { model: null | string, reasoningEffort: null | string }, models: { id: string, name: string, description?: undefined | string, reasoning?: undefined | { efforts: { id: string, name: string, description?: undefined | string }[], defaultEffort?: undefined | string } }[], defaultModel?: undefined | string, defaultReasoningEffort?: undefined | string }
export type GetApiTauriBridgeModelsQuerySessionId = string
export interface PostApiTauriBridgeModelsResponse { model: null | string, reasoningEffort: null | string }
export interface PostApiTauriBridgeSessionsResponse { sessionId: string }

export interface PostApiTauriBridgeModelsBody {
  sessionId: string
  model: null | string
  reasoningEffort: null | string
}
export interface PostApiTauriBridgeSessionsBody {
  backend: 'codex' | 'claude'
  workspaceId?: undefined | string
  cwd?: undefined | string
  agentPreset?: undefined | string
}
export interface GetApiTauriBridgeModelsQuery {
  sessionId: GetApiTauriBridgeModelsQuerySessionId
}
