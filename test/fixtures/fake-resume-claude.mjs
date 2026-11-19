/**
 * Stub `claude --print --input-format stream-json` as shipped in 2.1.x when a
 * session is resumed.
 *
 * Real-CLI behaviour reproduced here (issue #7): the `initialize` control
 * response carries the model catalogue, `hooks_applied: true` and
 * `session_state`, but **no** `session_id`, and the registered `SessionStart`
 * hook callback is never invoked before user input. The resumed id only appears
 * on the frames of the first turn.
 */
import process from 'node:process'

const resume = process.argv.slice(2).find(arg => arg.startsWith('--resume='))?.slice('--resume='.length)
if (resume === undefined) {
  process.stderr.write('fake resume claude: --resume=<id> is required\n')
  process.exit(2)
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function emitTurn() {
  send({ type: 'stream_event', session_id: resume, parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'resumed-msg' } } })
  send({ type: 'stream_event', session_id: resume, parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } })
  send({ type: 'stream_event', session_id: resume, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'resumed' } } })
  send({ type: 'assistant', session_id: resume, parent_tool_use_id: null, uuid: 'resumed-assistant', message: { id: 'resumed-msg', content: [{ type: 'text', text: 'resumed' }] } })
  send({
    type: 'result',
    subtype: 'success',
    session_id: resume,
    is_error: false,
    result: 'ok',
    usage: { input_tokens: 3, output_tokens: 2 },
  })
}

function handle(message) {
  if (message.type === 'control_request') {
    const request = message.request ?? {}
    const response = request.subtype === 'initialize'
      ? {
          models: [{ value: 'fake-model', displayName: 'Fake Model', supportedEffortLevels: ['low'] }],
          hooks_applied: true,
          session_state: 'idle',
          capabilities: ['ui_surface_v1'],
        }
      : {}
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } })
    return
  }
  if (message.type === 'user')
    emitTurn()
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
    if (line !== '')
      handle(JSON.parse(line))
  }
})
