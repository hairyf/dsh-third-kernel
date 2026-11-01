import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { HostContext } from '../types'
import { getHostContext } from '../context'
import { RequestError } from './request'
import getBackends from './routes/backends/get'
import getModels from './routes/models/get'
import postModels from './routes/models/post'
import postSessions from './routes/sessions/post'

export function server(ctx: HostContext): () => Promise<void> {
  return ctx.effect(function* () {
    const routes: ConnectionFetchRoute[] = [
      { path: '/api/tauri/bridge/backends', methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: respond(getBackends) },
      { path: '/api/tauri/bridge/models', methods: ['GET', 'HEAD', 'POST'], requestBody: 'buffered', fetch: respond(request => request.method === 'POST' ? postModels(request) : getModels(request)) },
      { path: '/api/tauri/bridge/sessions', methods: ['POST'], requestBody: 'buffered', fetch: respond(postSessions) },
    ]
    for (const route of routes)
      yield ctx.connection.fetch.register(route)
  }, 'native bridge: authenticated Fetch routes')

  function respond(handler: (request: Request) => Promise<unknown>): ConnectionFetchRoute['fetch'] {
    return async (request) => {
      let response: Response
      try {
        if (getHostContext() !== ctx)
          throw new Error('BRIDGE_DISPOSED: 原生桥接已卸载。')
        response = Response.json(await handler(request))
      }
      catch (error) {
        if (error instanceof RequestError) {
          response = Response.json({ error: error.message }, { status: 400 })
        }
        else {
          ctx.logger.error('Native bridge request failed', error)
          response = Response.json({ error: 'BRIDGE_INTERNAL_ERROR: 原生桥接请求失败。' }, { status: 500 })
        }
      }
      return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response
    }
  }
}
