'use strict'

// Sending the request and parsing the stream.
//
// WHAT HAPPENS HERE. The plugin translates harness messages into the request
// shape, sends it to the gateway, and translates the event stream back. The
// request shape is the most ordinary, OpenAI-compatible one: the gateway brings
// all providers to it, and the client side does not need to know who answers on
// the other end.
//
// WHAT IS NOT HERE: retries, header spoofing, transport selection, bypassing
// checks. The gateway does all of that, and duplicating it here would mean two
// places where one decision is made differently.

const { BASE, headers } = require('./daemon.cjs')
const { parseSse } = require('./sse.cjs')

// createStreamer creates an event generator for a single request.
async function* createStreamer(adapter, options) {
  const signal = options.signal
  if (signal?.aborted) return

  const body = buildBody(adapter, options)
  const url = `${BASE}/v1/chat/completions`

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    // The connection did not happen. This is a transport failure, not a
    // provider refusal: the client must see the difference.
    throw typedError(`gateway unreachable: ${errorText(error)}`, 'TRANSPORT')
  }

  if (!response.ok) {
    // The refusal is passed through VERBATIM. The gateway has already taken
    // care that the body, status, and headers match the service's response;
    // parsing them here would mean losing the signals by which the harness
    // decides whether to retry the request.
    //
    // The wait the service asked for travels under the name the retry
    // scheduler reads. A wait it cannot read is a wait it does not apply, and
    // the harness then retries on its own schedule — straight back into a
    // service that has just said "later".
    const detail = await response.text().catch(() => '')
    const status = response.status
    const wait = providerRetryAfterMs(response.headers)
    throw typedError(
      `gateway answered HTTP ${status}: ${detail.slice(0, 300)}`,
      failureCode(status, detail),
      // The field is added only when there is a wait to report: a key holding
      // undefined says nothing, and the invariant reads the presence of the
      // key rather than its value.
      wait === undefined ? { status } : { status, providerRetryAfterMs: wait },
    )
  }

  let sawContent = false
  for await (const event of parseSse(response, signal)) {
    if (event.type !== 'usage' && event.type !== 'finish') sawContent = true
    yield event
  }

  if (signal?.aborted) return
  if (!sawContent) {
    throw typedError('gateway ended the stream with no content', 'EMPTY_RESPONSE')
  }
}

// buildBody assembles the request body.
function buildBody(adapter, options) {
  const body = {
    // The identifier is composite: from it the gateway understands which
    // provider the request is addressed to.
    model: `${adapter.provider}/${options.model}`,
    messages: serializeMessages(options.messages, options.system),
    stream: true,
  }
  // The allowance is sent ONLY when the caller set one. An absent field leaves
  // the decision to the provider, which knows both the model's ceiling and its
  // own policy; a number written here instead would override that with a guess,
  // and the guess is wrong for most models — the gateway reports ceilings from
  // thirty-two thousand to a hundred and thirty-one thousand on the same free
  // tier.
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.reasoningEffort !== undefined) body.reasoning_effort = options.reasoningEffort

  const tools = serializeTools(options.tools)
  if (tools) body.tools = tools
  return body
}

// serializeMessages translates harness messages into the request shape.
//
// The system part goes as a separate message: that is how the gateway expects
// it, since it passes it to the provider separately from the history.
function serializeMessages(messages, system) {
  const out = []
  if (typeof system === 'string' && system.length > 0) {
    out.push({ role: 'system', content: system })
  }
  for (const message of messages || []) {
    const text = flattenText(message.content)
    switch (message.role) {
      case 'assistant': {
        const calls = toolCallsOf(message.content)
        const reasoning = reasoningOf(message.content)
        if (text === '' && !reasoning && calls.length === 0) continue
        const entry = { role: 'assistant', content: text }
        if (reasoning) entry.reasoning_content = reasoning
        if (calls.length > 0) entry.tool_calls = calls
        out.push(entry)
        break
      }
      case 'tool':
        out.push({
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: text || '(no output)',
        })
        break
      default:
        if (text !== '') out.push({ role: message.role, content: text })
        break
    }
  }
  return out
}

// flattenText collects the text from a message's content.
function flattenText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

// reasoningOf collects the assistant's reasoning.
function reasoningOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'reasoning' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

// toolCallsOf collects tool calls.
function toolCallsOf(content) {
  if (!Array.isArray(content)) return []
  return content
    .filter((block) => block && block.type === 'tool-call')
    .map((block) => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: block.arguments },
    }))
}

// serializeTools translates tool declarations.
function serializeTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters:
        tool.parameters && typeof tool.parameters === 'object'
          ? tool.parameters
          : { type: 'object', properties: {} },
    },
  }))
}




// typedError creates an error with a code and a snapshot of the failure.
//
// The harness distinguishes failures by the code field and by the failure
// snapshot. Without both it does not see the failure and does not apply its
// retry policy.
function typedError(message, code, extra = {}) {
  const error = new Error(message)
  error.code = code
  error.failure = { message, code, ...extra }
  return error
}


// errorText assembles a chain of causes from an error chain.
function errorText(err) {
  const parts = []
  const seen = new Set()
  let current = err
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current)
    parts.push(typeof current.message === "string" && current.message.length > 0 ? current.message : String(current.name || "error"))
    current = current.cause
  }
  return parts.length > 0 ? parts.join(": ") : String(err)
}

// failureCode picks the failure code in general terms.
//
// The codes match those the harness distinguishes. An access denial (403) is
// NOT treated as a key failure: with providers it can mean a regional ban, an
// exhausted entitlement, or anything else — the key has nothing to do with it.
const FAILURE_CODES = {
  401: "INVALID_CREDENTIAL",
  403: "PROVIDER_ERROR",
  409: "PROVIDER_ERROR",
  429: "RATE_LIMIT",
}

function failureCode(status, detail) {
  if (FAILURE_CODES[status]) return FAILURE_CODES[status]
  if (status >= 500) return "SERVER"
  return "PROVIDER_ERROR"
}

// providerRetryAfterMs reads the wait time from the headers.
//
// THE NAME IS PART OF THE CONTRACT. The retry scheduler looks for exactly
// providerRetryAfterMs on the failure snapshot; the same value under any other
// name is invisible to it, and the harness falls back to its own schedule. That
// is the whole reason this function exists.
//
// The order is the same as the harness's: first the millisecond header, then
// seconds. The value is needed so the harness can wait as long as the service
// asks, rather than on its usual schedule.
//
// NOTHING IS RETURNED WHEN THERE IS NO WAIT. The harness validates the field:
// a present-but-unusable value is a hard failure of the whole attempt, and zero
// is rejected along with NaN. Absence is the correct way to say "no wait was
// asked for".
function providerRetryAfterMs(headers) {
  const ms = Number(headers.get('retry-after-ms'))
  if (Number.isFinite(ms) && ms > 0) return ms
  const seconds = Number(headers.get('retry-after'))
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  return undefined
}

module.exports = {
  createStreamer,
  serializeMessages,
  serializeTools,
  buildBody,
  providerRetryAfterMs,
  failureCode,
}
