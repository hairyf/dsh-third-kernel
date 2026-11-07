/**
 * Stub `codex app-server` for the failure and accounting modes the normal
 * fixture does not cover: argv[2] selects the mode.
 *
 *  - `error`: announces a turn, then reports a native error and never sends
 *    turn/completed (a real app-server may end a provider failure that way).
 *  - `usage`: reports `thread/tokenUsage/updated` with cache counts folded into
 *    inputTokens, as OpenAI's own breakdown does.
 */
import { appendFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import process from 'node:process'

const mode = process.argv[2]
/**
 * Optional recorder path (argv[3]); every received frame is appended there.
 * The adapter appends the real CLI arguments after this fixture's own, so a run
 * without a recorder still has argv[3] — it is then the literal `app-server`.
 * Only an absolute path can be a recorder; anything else would drop a junk file
 * into the working directory.
 */
const record = process.argv[3] !== undefined && isAbsolute(process.argv[3]) ? process.argv[3] : undefined

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function handle(message) {
  const { id, method } = message
  if (record !== undefined)
    appendFileSync(record, `${JSON.stringify(message)}\n`)
  if (id === undefined)
    return
  if (method === 'initialize') {
    send({ id, result: { userAgent: 'fake-codex/0.0.0' } })
    return
  }
  if (method === 'thread/start') {
    send({ id, result: { thread: { id: 'thread-1' } } })
    return
  }
  if (method === 'thread/backgroundTerminals/list') {
    send({ id, result: { data: [] } })
    return
  }
  if (method === 'turn/start') {
    const turn = 'turn-1'
    send({ id, result: { turn: { id: turn } } })
    send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: turn, status: 'inProgress' } } })
    if (mode === 'usage') {
      send({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-1',
          turnId: turn,
          tokenUsage: {
            total: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 8, cacheWriteInputTokens: 2, outputTokens: 10, reasoningOutputTokens: 0 },
            last: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 8, cacheWriteInputTokens: 2, outputTokens: 10, reasoningOutputTokens: 0 },
            modelContextWindow: 200000,
          },
        },
      })
      send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: turn, itemId: 'item-1', delta: 'ok' } })
      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turn, status: 'completed', items: [] } } })
      return
    }
    send({ method: 'error', params: { threadId: 'thread-1', turnId: turn, willRetry: false, error: { message: 'provider exploded', codexErrorInfo: 'other' } } })
    return
  }
  send({ id, result: {} })
}

process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let end = buffer.indexOf('\n')
  while (end >= 0) {
    const line = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    end = buffer.indexOf('\n')
    if (line === '')
      continue
    handle(JSON.parse(line))
  }
})
