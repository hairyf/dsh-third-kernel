/**
 * Stub `codex app-server` for tests.
 *
 * It speaks the same JSON-RPC-over-stdio handshake as the real CLI and appends
 * every frame it receives to the file named by argv[2], so a test can assert
 * exactly which turn parameters the adapter serialised — without asserting the
 * vendor's own behaviour.
 */
import { appendFileSync } from 'node:fs'
import process from 'node:process'

const record = process.argv[2]
let turnId = 0

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function handle(message) {
  const { id, method } = message
  // Notifications (no id) need no answer.
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
  if (method === 'model/list') {
    send({
      id,
      result: {
        data: [
          { model: 'fake-model', displayName: 'Fake Model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }] },
          { model: 'hidden-model', hidden: true },
          { model: 'no-efforts-model', displayName: 'No Efforts' },
        ],
        nextCursor: null,
      },
    })
    return
  }
  if (method === 'turn/start') {
    turnId += 1
    const turn = `turn-${turnId}`
    send({ id, result: { turn: { id: turn } } })
    send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: turn, status: 'inProgress' } } })
    send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: turn, itemId: `item-${turnId}`, delta: 'ok' } })
    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turn, status: 'completed', items: [] } } })
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
    const message = JSON.parse(line)
    if (record !== undefined)
      appendFileSync(record, `${line}\n`)
    handle(message)
  }
})
