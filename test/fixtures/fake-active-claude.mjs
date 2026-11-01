import process from 'node:process'

const sessionId = process.argv.slice(2).find(arg => arg.startsWith('--session-id='))?.slice('--session-id='.length) ?? 'fake-session'
let hookSent = false

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function response(requestId, response = {}) {
  send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
}

function emitTurn() {
  send({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'root-msg' } } })
  send({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } })
  send({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'root' } } })
  send({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: 'child-tool', event: { type: 'message_start', message: { id: 'child-msg' } } })
  send({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: 'child-tool', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } })
  send({ type: 'stream_event', session_id: sessionId, parent_tool_use_id: 'child-tool', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'child' } } })
  send({ type: 'assistant', session_id: sessionId, parent_tool_use_id: null, uuid: 'root-assistant', message: { id: 'root-msg', content: [
    { type: 'text', text: 'root settled' },
    { type: 'tool_use', id: 'root-tool', name: 'Bash', input: { command: 'echo root' } },
  ] } })
  send({ type: 'assistant', session_id: sessionId, parent_tool_use_id: 'child-tool', uuid: 'child-assistant', message: { id: 'child-msg', content: [{ type: 'text', text: 'child settled' }] } })
  send({ type: 'user', session_id: sessionId, parent_tool_use_id: 'child-tool', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'root-tool', content: 'child output' }] } })
  // A background subagent whose report carries a status no whitelist knows: the
  // notification itself is the terminal report, so the turn must still end.
  send({ type: 'system', session_id: sessionId, subtype: 'task_started', task_id: 'task-1', task_type: 'local_agent' })
  send({ type: 'system', session_id: sessionId, subtype: 'task_notification', task_id: 'task-1', status: 'cancelled', summary: 'done' })
  send({
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    is_error: false,
    result: 'ok',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
  })
}

function handle(message) {
  if (message.type === 'control_request') {
    const request = message.request ?? {}
    response(message.request_id, request.subtype === 'initialize' ? { models: [{ value: 'fake-model', displayName: 'Fake Model', supportedEffortLevels: ['low'] }] } : {})
    if (request.subtype === 'initialize' && !hookSent) {
      hookSent = true
      send({ type: 'control_request', request_id: 'hook-1', request: { subtype: 'hook_callback', callback_id: 'dsh-native-session-identity', input: { hook_event_name: 'SessionStart', session_id: sessionId, model: 'fake-model' } } })
    }
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
