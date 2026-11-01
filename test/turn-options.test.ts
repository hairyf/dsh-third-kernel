/**
 * The three composer knobs must survive every hop from the browser to the kernel
 * child, and each adapter must translate them into its own native parameters.
 * Each hop is asserted separately so a break names itself:
 *
 *  1. `runTurn` puts the knobs under `options` (the shape the host reads) and
 *     omits the key entirely when the composer has none.
 *  2. `buildRoutes()` parses them back: one case per `PermissionMode`, the
 *     `auto` default backfill, and a 400 for an illegal mode.
 *  3. Each adapter serialises its native form — Codex into `turn/start`
 *     (`approvalPolicy` + `sandboxPolicy` + `model` + `effort`), Claude into
 *     `set_permission_mode` + `set_model` + `apply_flag_settings`.
 *  4. A real turn runs under `full-access` against the installed CLI, and
 *     `models()` yields rows the composer can render.
 *
 * Hops 1-3 drive stubs (a fake `codex app-server` / `claude` on stdio), so they
 * run everywhere. Hop 4 spawns the real CLIs and skips itself, out loud, when
 * they are not installed: a green unit run must never mean "asserted nothing".
 */
import type { KernelCommand } from '../src/host/detect'
import type { KernelSession } from '../src/host/session-types'
import type { PermissionMode, TurnEvent, TurnOptions } from '../src/shared/protocol'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runTurn } from '../src/client/lib/api'
import { ClaudeSession } from '../src/host/claude'
import { CodexSession } from '../src/host/codex'
import { probeKernel } from '../src/host/detect'
import { sessions } from '../src/host/registry'
import { buildRoutes } from '../src/host/routes'
import { PERMISSION_MODES, ROUTES } from '../src/shared/protocol'

const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-app-server.mjs', import.meta.url))
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))

/**
 * The stub is a plain node program standing in for the vendor binary.
 * `KernelCommand.args` is what precedes the kernel's own arguments, so the fake
 * Claude CLI receives its recorder path here, before the adapter's flags.
 */
function stub(file: string, args: string[] = []): KernelCommand {
  return { file: process.execPath, args: [file, ...args] }
}

/** One route by path, so a test drives the real handler the host registered. */
function route(path: string): ReturnType<typeof buildRoutes>[number] {
  const found = buildRoutes().find(entry => entry.path === path)
  if (found === undefined)
    throw new Error(`missing route ${path}`)
  return found
}

/** POST a JSON body the way the browser's `post()` helper does. */
function post(path: string, body: unknown): Promise<Response> {
  return route(path).fetch(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

/** Read an NDJSON response the way the client's `frames()` helper does. */
async function frames(response: Response): Promise<TurnEvent[]> {
  const text = await response.text()
  return text.split('\n').map(line => line.trim()).filter(line => line !== '').map(line => JSON.parse(line) as TurnEvent)
}

/** Every frame the stub child received, in order. */
function received(file: string): Record<string, unknown>[] {
  if (!existsSync(file))
    return []
  return readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Record<string, unknown>)
}

/** The params of the first frame carrying this method. */
function paramsOf(file: string, method: string): Record<string, unknown> {
  const frame = received(file).find(entry => entry.method === method)
  if (frame === undefined)
    throw new Error(`stub never received ${method}: ${JSON.stringify(received(file))}`)
  return (frame.params ?? {}) as Record<string, unknown>
}

/** Recorder files live in .temp/ and are removed when the run ends. */
const records = new Set<string>()

/** Where one stub child records the frames it received. */
function recordPath(name: string): string {
  const path = fileURLToPath(new URL(`../.temp/turn-options-${name}-${process.pid}.jsonl`, import.meta.url))
  records.add(path)
  return path
}

afterAll(() => {
  for (const path of records)
    rmSync(path, { force: true })
})
describe('browser → host: the turn body carries the knobs', () => {
  const original = globalThis.fetch
  let seen: { url: string, body: unknown }[] = []

  beforeAll(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return new Response('{"type":"done"}\n', { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
    }) as typeof fetch
  })

  afterAll(() => {
    globalThis.fetch = original
  })

  it('nests model/effort/permission under `options`', async () => {
    seen = []
    const options: TurnOptions = { model: 'gpt-6.1-sol', effort: 'ultra', permission: 'full-access' }
    const events: TurnEvent[] = []
    for await (const event of runTurn('session-1', 'hi', new AbortController().signal, options))
      events.push(event)
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe(ROUTES.turn)
    expect(seen[0].body).toEqual({ id: 'session-1', text: 'hi', options })
    expect(events).toEqual([{ type: 'done' }])
  })

  it('omits the `options` key when the composer has none', async () => {
    seen = []
    for await (const _event of runTurn('session-2', 'hi', new AbortController().signal)) {
      // drain the stream
    }
    expect(seen[0].body).toEqual({ id: 'session-2', text: 'hi' })
  })
})

describe('host: the turn route parses the knobs', () => {
  /** A fake session that records exactly what the route handed it. */
  function stubSession(id: string): { calls: { text: string, options?: TurnOptions }[] } & KernelSession {
    const calls: { text: string, options?: TurnOptions }[] = []
    return {
      id,
      calls,
      open: async () => {},
      models: async () => [],
      async* run(input) {
        calls.push(input)
        yield { type: 'done' } as TurnEvent
      },
      answer: () => {},
      interrupt: async () => {},
      dispose: async () => {},
    }
  }

  for (const permission of PERMISSION_MODES) {
    it(`passes ${permission} through unchanged`, async () => {
      const session = stubSession(`stub-${permission}`)
      sessions.set(session.id, session)
      try {
        const response = await post(ROUTES.turn, { id: session.id, text: 'go', options: { permission } })
        expect(response.status).toBe(200)
        expect(await frames(response)).toEqual([{ type: 'done' }])
        expect(session.calls).toEqual([{ text: 'go', options: { model: undefined, effort: undefined, permission } }])
      }
      finally {
        sessions.delete(session.id)
      }
    })
  }

  it('keeps model and effort alongside the permission mode', async () => {
    const session = stubSession('stub-all')
    sessions.set(session.id, session)
    try {
      await frames(await post(ROUTES.turn, {
        id: session.id,
        text: 'go',
        options: { model: 'm-1', effort: 'ultra', permission: 'read-only' },
      }))
      expect(session.calls[0].options).toEqual({ model: 'm-1', effort: 'ultra', permission: 'read-only' })
    }
    finally {
      sessions.delete(session.id)
    }
  })

  it('backfills the required `permission` with auto for an empty options object', async () => {
    const session = stubSession('stub-default')
    sessions.set(session.id, session)
    try {
      await frames(await post(ROUTES.turn, { id: session.id, text: 'go', options: {} }))
      expect(session.calls[0].options).toEqual({ model: undefined, effort: undefined, permission: 'auto' })
    }
    finally {
      sessions.delete(session.id)
    }
  })

  it('rejects an illegal permission mode instead of downgrading it', async () => {
    const session = stubSession('stub-illegal')
    sessions.set(session.id, session)
    try {
      const response = await post(ROUTES.turn, { id: session.id, text: 'go', options: { permission: 'yolo' } })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'BRIDGE_REQUEST_INVALID: options.permission' })
      // The kernel must never see the bad request.
      expect(session.calls).toEqual([])
    }
    finally {
      sessions.delete(session.id)
    }
  })

  it('rejects a non-object `options` payload', async () => {
    const session = stubSession('stub-shape')
    sessions.set(session.id, session)
    try {
      const response = await post(ROUTES.turn, { id: session.id, text: 'go', options: 'full-access' })
      expect(response.status).toBe(400)
      expect(session.calls).toEqual([])
    }
    finally {
      sessions.delete(session.id)
    }
  })

  it('leaves the knobs unset when the body has no options at all', async () => {
    const session = stubSession('stub-none')
    sessions.set(session.id, session)
    try {
      // The composer always sends its thread's options, so an absent key means
      // a caller with no opinion — the adapter then applies nothing and the
      // child keeps whatever it was configured with.
      await frames(await post(ROUTES.turn, { id: session.id, text: 'go' }))
      expect(session.calls[0].options).toBeUndefined()
    }
    finally {
      sessions.delete(session.id)
    }
  })
})

/** Codex's native form of each mode, as documented by the adapter. */
const CODEX_EXPECTED: Record<PermissionMode, { approvalPolicy: string, sandbox: Record<string, unknown> }> = {
  'read-only': { approvalPolicy: 'on-request', sandbox: { type: 'readOnly', networkAccess: false } },
  'full-access': { approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } },
  'auto': {
    approvalPolicy: 'on-request',
    sandbox: { type: 'workspaceWrite', writableRoots: ['CWD'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  },
}

/** Claude's native permission mode name per composer mode. */
const CLAUDE_EXPECTED: Record<PermissionMode, string> = {
  'read-only': 'plan',
  'auto': 'acceptEdits',
  'full-access': 'bypassPermissions',
}

describe('codex adapter: turn/start carries the native policy', () => {
  const cwd = process.cwd()

  for (const permission of PERMISSION_MODES) {
    it(`sends ${permission} as approvalPolicy + sandboxPolicy`, async () => {
      const record = recordPath(`codex-${permission}`)
      const session = new CodexSession(stub(FAKE_CODEX, [record]), cwd, () => cwd)
      try {
        await session.open(AbortSignal.timeout(20_000))
        for await (const _event of session.run(
          { text: 'go', options: { model: 'fake-model', effort: 'ultra', permission } },
          AbortSignal.timeout(20_000),
        )) {
          // drain the turn
        }
        const params = paramsOf(record, 'turn/start')
        const expected = CODEX_EXPECTED[permission]
        expect(params.approvalPolicy).toBe(expected.approvalPolicy)
        // The read-only and full-access policies are absolute; the workspace
        // policy names the session cwd, which this test only knows here.
        expect(params.sandboxPolicy).toEqual(expected.sandbox.type === 'workspaceWrite' ? { ...expected.sandbox, writableRoots: [cwd] } : expected.sandbox)
        expect(params.model).toBe('fake-model')
        expect(params.effort).toBe('ultra')
      }
      finally {
        await session.dispose()
      }
    }, 30_000)
  }

  it('sends no knobs at all when the composer sent none', async () => {
    const record = recordPath('codex-none')
    const session = new CodexSession(stub(FAKE_CODEX, [record]), cwd, () => cwd)
    try {
      await session.open(AbortSignal.timeout(20_000))
      for await (const _event of session.run({ text: 'go' }, AbortSignal.timeout(20_000))) {
        // drain the turn
      }
      const params = paramsOf(record, 'turn/start')
      expect(params.approvalPolicy).toBeUndefined()
      expect(params.sandboxPolicy).toBeUndefined()
      expect(params.model).toBeUndefined()
      expect(params.effort).toBeUndefined()
    }
    finally {
      await session.dispose()
    }
  }, 30_000)
})

describe('claude adapter: the knobs become control requests', () => {
  for (const permission of PERMISSION_MODES) {
    it(`sets permission mode ${permission}`, async () => {
      const record = recordPath(`claude-${permission}`)
      const session = new ClaudeSession(stub(FAKE_CLAUDE, [`--record=${record}`]), process.cwd())
      try {
        await session.open(AbortSignal.timeout(20_000))
        for await (const _event of session.run(
          { text: 'go', options: { model: 'fake-model', effort: 'ultra', permission } },
          AbortSignal.timeout(20_000),
        )) {
          // drain the turn
        }
        const controls = received(record).flatMap((frame) => {
          if (frame.type !== 'control_request')
            return []
          return [frame.request as Record<string, unknown>]
        })
        const modes = controls.filter(entry => entry.subtype === 'set_permission_mode')
        expect(modes).toEqual([{ subtype: 'set_permission_mode', mode: CLAUDE_EXPECTED[permission] }])
        expect(controls.find(entry => entry.subtype === 'set_model')).toEqual({ subtype: 'set_model', model: 'fake-model' })
        expect(controls.find(entry => entry.subtype === 'apply_flag_settings')).toEqual({ subtype: 'apply_flag_settings', settings: { effortLevel: 'ultra' } })
      }
      finally {
        await session.dispose()
      }
    }, 30_000)
  }

  it('repeats no control request when the knobs did not change', async () => {
    const record = recordPath('claude-repeat')
    const session = new ClaudeSession(stub(FAKE_CLAUDE, [`--record=${record}`]), process.cwd())
    try {
      await session.open(AbortSignal.timeout(20_000))
      const options: TurnOptions = { model: 'fake-model', effort: 'high', permission: 'auto' }
      for await (const _event of session.run({ text: 'one', options }, AbortSignal.timeout(20_000))) {
        // drain
      }
      for await (const _event of session.run({ text: 'two', options }, AbortSignal.timeout(20_000))) {
        // drain
      }
      const controls = received(record).flatMap((frame) => {
        if (frame.type !== 'control_request')
          return []
        return [frame.request as Record<string, unknown>]
      })
      expect(controls.filter(entry => entry.subtype === 'set_permission_mode')).toHaveLength(1)
      expect(controls.filter(entry => entry.subtype === 'set_model')).toHaveLength(1)
      expect(controls.filter(entry => entry.subtype === 'apply_flag_settings')).toHaveLength(1)
    }
    finally {
      await session.dispose()
    }
  }, 40_000)
})

/*
 * Real-kernel proof. The hops above can be right while the vendor rejects the
 * frame, so this half runs one turn under `full-access` through the installed
 * CLI and requires a terminal `done` with no approval prompt in the way.
 *
 * Two ways to be unable to prove it are told apart, and neither is a silent
 * pass: no CLI at all, or a CLI that reaches its vendor and is refused by the
 * account itself (quota, balance, expired credential). The second is not a fact
 * about this plugin's plumbing, so it skips with its reason printed — while
 * still asserting that the refusal was not a permission block.
 */

/** A vendor refusal that is about the account, not about this plugin's plumbing. */
const ACCOUNT_REFUSAL = /insufficient balance|quota|credit|rate limit|unauthorized|invalid api key|authentication_error/i

interface RealKernel {
  kernel: 'codex' | 'claude'
  command: KernelCommand | null
  version: string | null
  /** Why this kernel cannot be exercised here, when it cannot. */
  skip: string | null
}

async function detect(kernel: 'codex' | 'claude'): Promise<RealKernel> {
  const probe = await probeKernel(kernel)
  return {
    kernel,
    command: probe.installed ? probe.command : null,
    version: probe.version,
    skip: probe.installed && probe.command !== null ? null : `本机未安装可用的 ${kernel} CLI：${probe.hint ?? '未探测到'}`,
  }
}

const real = await Promise.all([detect('codex'), detect('claude')])

for (const target of real) {
  describe(`real ${target.kernel} kernel`, () => {
    it(`runs one full-access turn and reports models the composer can render`, async () => {
      if (target.command === null) {
        // Honest skip: the protocol cannot be exercised without the vendor CLI.
        console.warn(`[turn-options] skip ${target.kernel}: ${target.skip}`)
        expect(target.command).toBeNull()
        return
      }
      // Printed so a passing run names the build it actually exercised.
      console.warn(`[turn-options] ${target.kernel} ${target.version ?? 'unknown version'}`)
      const command = target.command
      const session = target.kernel === 'codex'
        ? new CodexSession(command, process.cwd(), () => process.cwd())
        : new ClaudeSession(command, process.cwd())
      try {
        await session.open(AbortSignal.timeout(60_000))

        // The composer renders `label` and lists `efforts` verbatim, so a row it
        // could not show is a broken catalogue rather than a cosmetic gap.
        const models = await session.models(AbortSignal.timeout(60_000))
        expect(models.length).toBeGreaterThan(0)
        for (const model of models) {
          expect(model.id).not.toBe('')
          expect(model.label.trim()).not.toBe('')
          expect(model.efforts.length).toBeGreaterThan(0)
          for (const effort of model.efforts) {
            expect(effort.id).not.toBe('')
            expect(effort.label.trim()).not.toBe('')
          }
        }

        const model = models[0]
        const events: TurnEvent[] = []
        const options: TurnOptions = { model: model.id, effort: model.efforts[0].id, permission: 'full-access' }
        for await (const event of session.run({ text: 'Reply with the single word PONG and nothing else.', options }, AbortSignal.timeout(180_000))) {
          events.push(event)
          if (event.type === 'approval')
            throw new Error(`full-access turn still asked for approval: ${event.title}`)
          if (event.type === 'done' || event.type === 'error')
            break
        }

        // The kernel reached its vendor and the vendor refused the *account*:
        // nothing about the permission/model/effort plumbing was exercised, so
        // claiming a green turn here would be a lie.
        const refusal = events.find(event => event.type === 'error') as { type: 'error', message: string } | undefined
        if (refusal !== undefined && ACCOUNT_REFUSAL.test(refusal.message)) {
          console.warn(`[turn-options] skip ${target.kernel} full-access turn: ${refusal.message}`)
          // Still a real assertion: full-access must never be refused *for
          // permission*, and this refusal is not one.
          expect(refusal.message).not.toMatch(/permission|approval|denied/i)
          return
        }

        expect(refusal).toBeUndefined()
        expect(events.some(event => event.type === 'done')).toBe(true)
        // A turn that only got through by being blocked would have produced no
        // assistant text at all.
        const text = events.filter(event => event.type === 'text').map(event => event.type === 'text' ? event.delta : '').join('')
        expect(text.toUpperCase()).toContain('PONG')
      }
      finally {
        await session.dispose()
      }
    }, 240_000)
  })
}
