/**
 * HTTP surface for the two kernels.
 *
 * Every route is an exact Fetch route on the authenticated `/api` channel, so
 * Connection has already applied its Host/Origin fence and browser
 * authentication before a handler runs, and only the owner peer reaches them.
 * Payloads are still validated here: a malformed body must be rejected at the
 * trust boundary, not half-applied to a kernel.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { InstallEvent, KernelId, KernelState, ThirdPartyKernelId, TurnEvent } from '../shared/protocol'
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { ROUTES, THIRD_PARTY_KERNELS } from '../shared/protocol'
import { probeKernel } from './detect'
import { installKernel } from './installer'
import { openSession, sessions } from './registry'

/** One exact route on the shared API channel, as Connection consumes it. */
interface FetchRoute {
  path: string
  methods: readonly ('GET' | 'HEAD' | 'POST')[]
  requestBody: 'buffered' | 'streaming'
  fetch: (request: Request) => Promise<Response>
}

/** The slice of `ctx.connection` this plugin needs. */
interface ConnectionService {
  fetch: { register: (route: FetchRoute) => () => Promise<void> }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

/**
 * Stream newline-delimited JSON so the browser reads events as they happen.
 * Closing the request (or the client navigating away) cancels the producer.
 */
function ndjson<T>(signal: AbortSignal, source: AsyncIterable<T>): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const item of source) {
          if (signal.aborted)
            break
          controller.enqueue(encoder.encode(`${JSON.stringify(item)}\n`))
        }
        controller.close()
      }
      catch (error) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : String(error) })}\n`))
        controller.close()
      }
    },
    cancel() {},
  })
  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  })
}

function isThirdParty(id: unknown): id is ThirdPartyKernelId {
  return typeof id === 'string' && (THIRD_PARTY_KERNELS as readonly string[]).includes(id)
}

/** The switcher's whole state: one detection row per kernel. */
async function statePayload(): Promise<{ kernels: KernelState[], cwd: string }> {
  const rows = await Promise.all(THIRD_PARTY_KERNELS.map(async (id): Promise<KernelState> => {
    const result = await probeKernel(id)
    return { id, installed: result.installed, version: result.version, executable: result.executable, hint: result.hint }
  }))
  // The official kernel needs no probe: it is the process serving this request.
  return { kernels: [{ id: 'dsh' as KernelId, installed: true, version: null, executable: null, hint: null }, ...rows], cwd: process.cwd() }
}

/** Resolve a requested directory to an existing absolute path. */
async function resolveCwd(requested: unknown): Promise<string> {
  if (requested === undefined || requested === null || requested === '')
    return process.cwd()
  if (typeof requested !== 'string')
    throw new Error('BRIDGE_REQUEST_INVALID: cwd')
  const absolute = resolve(requested)
  if (!(await stat(absolute)).isDirectory())
    throw new Error('BRIDGE_REQUEST_INVALID: cwd 不是目录')
  return realpath(absolute)
}

async function body(request: Request): Promise<Record<string, unknown> | undefined> {
  const value = await request.json().catch(() => undefined)
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Build the exact routes this plugin contributes. */
export function buildRoutes(): FetchRoute[] {
  return [
    {
      path: ROUTES.state,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => json(await statePayload()),
    },
    {
      path: ROUTES.install,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const input = await body(request)
        if (!isThirdParty(input?.kernel))
          return json({ error: 'BRIDGE_BACKEND_INVALID: 请选择 Codex 或 Claude。' }, 400)
        const handle = installKernel(input.kernel)
        // A dropped request cancels the install instead of leaving an unattended
        // global npm run behind.
        request.signal.addEventListener('abort', handle.cancel, { once: true })
        return ndjson<InstallEvent>(request.signal, handle.events)
      },
    },
    {
      path: ROUTES.session,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const input = await body(request)
        if (!isThirdParty(input?.kernel))
          return json({ error: 'BRIDGE_BACKEND_INVALID: 请选择 Codex 或 Claude。' }, 400)
        let cwd: string
        try {
          cwd = await resolveCwd(input.cwd)
        }
        catch (error) {
          return json({ error: error instanceof Error ? error.message : 'BRIDGE_REQUEST_INVALID' }, 400)
        }
        const probe = await probeKernel(input.kernel)
        if (!probe.installed || probe.command === null)
          return json({ error: probe.hint ?? '内核未安装', installed: false }, 409)
        try {
          const session = await openSession(input.kernel, probe.command, cwd)
          const models = await session.models().catch(() => [])
          return json({ id: session.id, kernel: input.kernel, cwd, models })
        }
        catch (error) {
          return json({ error: error instanceof Error ? error.message : 'BRIDGE_SESSION_FAILED' }, 500)
        }
      },
    },
    {
      path: ROUTES.turn,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const input = await body(request)
        if (typeof input?.id !== 'string' || typeof input.text !== 'string' || input.text.trim() === '')
          return json({ error: 'BRIDGE_REQUEST_INVALID: id/text' }, 400)
        const session = sessions.get(input.id)
        if (session === undefined)
          return json({ error: 'BRIDGE_SESSION_UNKNOWN: 会话不存在或已关闭' }, 404)
        return ndjson<TurnEvent>(request.signal, session.run({ text: input.text }, request.signal))
      },
    },
    {
      path: ROUTES.answer,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const input = await body(request)
        if (typeof input?.id !== 'string' || typeof input.requestId !== 'string')
          return json({ error: 'BRIDGE_REQUEST_INVALID: id/requestId' }, 400)
        const session = sessions.get(input.id)
        if (session === undefined)
          return json({ error: 'BRIDGE_SESSION_UNKNOWN' }, 404)
        if (typeof input.allowed === 'boolean')
          session.answer(input.requestId, { kind: 'approval', allowed: input.allowed })
        else if (input.answers !== null && typeof input.answers === 'object' && !Array.isArray(input.answers))
          session.answer(input.requestId, { kind: 'question', answers: input.answers as Record<string, string | string[]> })
        else
          return json({ error: 'BRIDGE_REQUEST_INVALID: allowed/answers' }, 400)
        return json({ ok: true })
      },
    },
    {
      path: ROUTES.interrupt,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const input = await body(request)
        if (typeof input?.id !== 'string')
          return json({ error: 'BRIDGE_REQUEST_INVALID: id' }, 400)
        await sessions.get(input.id)?.interrupt()
        return json({ ok: true })
      },
    },
    {
      path: ROUTES.close,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const input = await body(request)
        if (typeof input?.id !== 'string')
          return json({ error: 'BRIDGE_REQUEST_INVALID: id' }, 400)
        const session = sessions.get(input.id)
        if (session !== undefined) {
          sessions.delete(input.id)
          await session.dispose()
        }
        return json({ ok: true })
      },
    },
  ]
}

/** Register every route; the returned disposer releases the whole set. */
export function mountRoutes(ctx: Context): () => void {
  const connection = ctx.get('connection') as ConnectionService | undefined
  if (connection === undefined)
    throw new Error('dsh-third-kernel: 需要 connection 服务来承载内核接口')
  const disposers = buildRoutes().map(route => connection.fetch.register(route))
  return () => {
    for (const dispose of disposers)
      void dispose().catch(() => {})
  }
}
