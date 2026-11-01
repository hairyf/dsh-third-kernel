import type { HostContext } from '../types'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../apply'
import { activateHost, getHostConfig, getHostContext } from '../context'
import { adapter } from '../service/adapter'
import { backend } from '../service/backend'
import { checkpoint } from '../service/checkpoint'
import { identity } from '../service/identity'
import { model } from '../service/model'
import { session } from '../service/session'
import { server } from './index'

afterEach(() => vi.restoreAllMocks())

it('unmounts routes before awaiting native cleanup and releases context last', async () => {
  const ctx = new Context()
  const connection = new HostConnectionService(ctx, [], {} as ConstructorParameters<typeof HostConnectionService>[2])
  const host = ctx as HostContext
  vi.spyOn(identity, 'register').mockResolvedValue(() => {})
  vi.spyOn(model, 'register').mockResolvedValue(() => {})
  vi.spyOn(checkpoint, 'register').mockResolvedValue(() => {})
  vi.spyOn(adapter, 'register').mockResolvedValue(() => {})
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const cleanup = vi.spyOn(session, 'dispose').mockImplementation(async () => {
    expect(getHostContext()).toBe(host)
    await pending
    expect(getHostContext()).toBe(host)
  })
  vi.spyOn(backend, 'getCatalog').mockResolvedValue([])
  apply(host, { claudePath: 'configured-claude' })
  const handler = connection.createSharedFetchHandler('/api')
  const request = new Request('http://localhost/api/tauri/bridge/backends')
  await vi.waitFor(async () => expect((await handler.fetch(request, connection.browserPeer)).status).toBe(200))
  const disposing = ctx.fiber.dispose()
  try {
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalled())
    expect((await handler.fetch(request, connection.browserPeer)).status).toBe(404)
    expect(getHostConfig()).toEqual({ claudePath: 'configured-claude' })
  }
  finally {
    finish()
    await disposing
  }
  expect(() => getHostContext()).toThrow('BRIDGE_DISPOSED')
})

it('keeps buffered bridge routes, validation and awaited owner cleanup on the official registry', async () => {
  const ctx = new Context()
  const connection = new HostConnectionService(ctx, [], {} as ConstructorParameters<typeof HostConnectionService>[2])
  const host = ctx as HostContext
  const config = { codexPath: 'configured-codex', probeTimeoutMs: 1234 }
  const release = activateHost(host, config)
  const catalog = vi.spyOn(backend, 'getCatalog').mockResolvedValue([])
  const models = vi.spyOn(model, 'getCatalog').mockResolvedValue({ backend: 'codex', models: [], current: { model: null, reasoningEffort: null } })
  const select = vi.spyOn(model, 'select').mockResolvedValue({ model: null, reasoningEffort: null })
  const create = vi.spyOn(session, 'create').mockResolvedValue({ sessionId: 'created' })
  const log = vi.spyOn(host.logger, 'error').mockImplementation(() => {})
  const stop = server(host)
  const handler = connection.createSharedFetchHandler('/api')
  const send = (path: string, method = 'GET', body?: string) => handler.fetch(new Request(`http://localhost/api/tauri/bridge/${path}`, { method, ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }) }), connection.browserPeer)
  try {
    expect(getHostContext()).toBe(host)
    expect(getHostConfig()).toBe(config)
    expect(() => activateHost(host, {})).toThrow('BRIDGE_OWNER_CONFLICT')
    for (const path of ['backends', 'models', 'sessions'])
      expect(handler.requestBodyMode({ method: 'POST', url: new URL(`http://localhost/api/tauri/bridge/${path}`) })).toBe('buffered')
    expect(await (await send('backends')).json()).toEqual([])
    expect((await send('backends', 'HEAD')).body).toBeNull()
    expect((await send('models?sessionId=s')).status).toBe(200)
    expect(models).toHaveBeenCalledWith('s')
    for (const path of ['models', 'models?sessionId=', 'models?sessionId=%20', 'models?sessionId=s&sessionId=t'])
      expect((await send(path)).status).toBe(400)
    for (const body of ['', '{', 'null', '[]', '{}', '{"sessionId":"s"}', '{"sessionId":"s","model":" ","reasoningEffort":null}'])
      expect((await send('models', 'POST', body)).status).toBe(400)
    expect(select).not.toHaveBeenCalled()
    expect((await send('models', 'POST', '{"sessionId":"s","model":null,"reasoningEffort":null}')).status).toBe(200)
    expect(select).toHaveBeenCalledWith('s', { model: null, reasoningEffort: null })
    for (const body of ['null', '[]', '{}', '{"backend":"dsh"}', '{"backend":"codex","cwd":" "}', '{"backend":"claude","workspaceId":"w","cwd":"/tmp"}'])
      expect((await send('sessions', 'POST', body)).status).toBe(400)
    expect(create).not.toHaveBeenCalled()
    expect(await (await send('sessions', 'POST', '{"backend":"claude","agentPreset":"p"}')).json()).toEqual({ sessionId: 'created' })
    expect(create).toHaveBeenCalledWith('claude', undefined, undefined, 'p')
    create.mockRejectedValueOnce(new Error('BRIDGE_CWD_INVALID: invalid directory'))
    expect((await send('sessions', 'POST', '{"backend":"codex"}')).status).toBe(400)
    catalog.mockRejectedValueOnce(new Error('private stack detail'))
    const failed = await send('backends')
    expect(failed.status).toBe(500)
    expect(await failed.text()).not.toContain('private stack detail')
    expect(log).toHaveBeenCalledOnce()
    expect((await send('backends', 'POST', '{}')).status).toBe(404)
    expect((await send('backends/extra')).status).toBe(404)
    await stop()
    expect((await send('backends')).status).toBe(404)
    expect(getHostContext()).toBe(host)
  }
  finally {
    await stop()
    release()
    await ctx.fiber.dispose()
  }
  expect(() => getHostContext()).toThrow('BRIDGE_DISPOSED')
  expect(() => getHostConfig()).toThrow('BRIDGE_DISPOSED')
  const releaseNext = activateHost(host, {})
  release()
  expect(getHostContext()).toBe(host)
  releaseNext()
})
