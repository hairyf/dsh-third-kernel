/**
 * Stub `claude --print --input-format stream-json` for tests.
 *
 * Records every frame it receives to the file named by `--record=<path>`, answers
 * each control request successfully, and ends the turn with a `result` frame so
 * the adapter's own translation is the only thing under test.
 */
import { appendFileSync } from 'node:fs'
import process from 'node:process'

const record = process.argv.slice(2).find(arg => arg.startsWith('--record='))?.slice('--record='.length)

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function handle(message) {
  if (message.type === 'control_request') {
    const request = message.request ?? {}
    const response = request.subtype === 'initialize'
      ? {
          models: [
            { value: 'fake-model', displayName: 'Fake Model', supportedEffortLevels: ['low', 'ultra'] },
            { value: 'no-effort-model', displayName: 'No Effort', supportsEffort: false },
          ],
        }
      : {}
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
    return
  }
  if (message.type === 'user') {
    send({ type: 'result', subtype: 'success', session_id: message.session_id, is_error: false, result: 'ok' })
  }
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
