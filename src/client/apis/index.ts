import type { FetchOptions } from '../lib/request'
/* Generated bridge API; kept local so the client bundle has no ofetch dependency. */
import type * as Types from './index.type'
import { request } from '../lib/request'

export function getBackends(options?: FetchOptions): Promise<Types.GetApiTauriBridgeBackendsResponse> {
  return request<Types.GetApiTauriBridgeBackendsResponse>('/api/tauri/bridge/backends', { method: 'GET', ...options })
}
export function getModels(params: Types.GetApiTauriBridgeModelsQuery, options?: FetchOptions): Promise<Types.GetApiTauriBridgeModelsResponse> {
  return request<Types.GetApiTauriBridgeModelsResponse>('/api/tauri/bridge/models', { method: 'GET', params: params as unknown as Record<string, string>, ...options })
}
export function postModels(body: Types.PostApiTauriBridgeModelsBody, options?: FetchOptions): Promise<Types.PostApiTauriBridgeModelsResponse> {
  return request<Types.PostApiTauriBridgeModelsResponse>('/api/tauri/bridge/models', { method: 'POST', body, ...options })
}
export function postSessions(body: Types.PostApiTauriBridgeSessionsBody, options?: FetchOptions): Promise<Types.PostApiTauriBridgeSessionsResponse> {
  return request<Types.PostApiTauriBridgeSessionsResponse>('/api/tauri/bridge/sessions', { method: 'POST', body, ...options })
}
