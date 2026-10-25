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

// IMAGE_POLICY — the request-image budget this route applies to every image.
//
// The numbers are the harness defaults for a route that declares no limits of
// its own: four megapixels and one mebibyte of encoded bytes. They are here, and
// not taken from the provider, because the gateway does not report per-model
// image limits — and a route that resized differently would send the provider a
// different image than the one the harness priced.
const IMAGE_POLICY = Object.freeze({ maxPixels: 4194304, maxBytes: 1048576 })

// OFFLOADED_IMAGE_TEXT — what a model sees in place of an image the harness
// decided not to send.
//
// The decision belongs to the harness: an image carrying offloaded:true was
// dropped to fit a request budget by a previous attempt, and re-sending it would
// undo that. Saying so in words keeps the model from claiming it saw nothing.
const OFFLOADED_IMAGE_TEXT = '[image omitted to fit request image limits]'

// createStreamer creates an event generator for a single request.
async function* createStreamer(adapter, options) {
  const signal = options.signal
  if (signal?.aborted) return

  const body = buildBody(adapter, options, await prepareImages(adapter, options))
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
function buildBody(adapter, options, images) {
  const body = {
    // The identifier is composite: from it the gateway understands which
    // provider the request is addressed to.
    model: `${adapter.provider}/${options.model}`,
    messages: serializeMessages(options.messages, options.system, images),
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
//
// A user message keeps its images. The harness hands an image-capable route
// typed blocks, and this is the only place where they become a request: a
// message flattened to its text alone is a message from which the image has
// disappeared, and the model then answers about an image it never received.
// Images go as data URLs because the gateway accepts no other form — it never
// fetches an address on the client's behalf.
function serializeMessages(messages, system, images) {
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
      default: {
        // The string form is kept whenever the message carries no image: a
        // plain string is what every provider accepts without conditions, and
        // an array of one text part is the same request written less portably.
        const content = contentParts(message.content, images)
        if (typeof content === 'string') {
          if (content !== '') out.push({ role: message.role, content })
        } else if (content.length > 0) {
          out.push({ role: message.role, content })
        }
        break
      }
    }
  }
  return out
}

// contentParts translates one message's content into the request form: a plain
// string when it is text only, and a list of parts when an image is among them.
function contentParts(content, images) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type !== 'image') continue
    if (block.offloaded === true) {
      parts.push({ type: 'text', text: OFFLOADED_IMAGE_TEXT })
      continue
    }
    const id = block.attachment?.attachmentId
    const version = images?.get(id)
    if (version === undefined) {
      // Every retained image is read before the request is built, so a missing
      // one is a defect rather than a decision. Sending the request without it
      // would hide the defect behind an answer about nothing.
      throw typedError(`request image ${String(id)} was not read`, 'INVALID_REQUEST')
    }
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}` },
    })
  }
  if (parts.every((part) => part.type === 'text')) return parts.map((part) => part.text).join('')
  return parts
}

// prepareImages reads one request version of every image the request retains.
//
// The bytes come from the harness attachment service, which is the only owner
// of the stored object: the plugin holds a durable reference and nothing more.
// One read per attachment, not per occurrence, because the same image may be
// attached to several messages and the versions are identical.
async function prepareImages(adapter, options) {
  const refs = imageRefsOf(options.messages)
  if (refs.length === 0) return undefined

  const attachments = adapter?.ctx?.get?.('attachments')
  if (attachments === undefined || typeof attachments.readImageRequest !== 'function') {
    throw typedError('the attachment service is not mounted; images cannot be sent', 'UNSUPPORTED_CONTENT')
  }

  const versions = new Map()
  for (const ref of refs) {
    versions.set(ref.attachmentId, await attachments.readImageRequest(ref, requestTarget(ref), options.signal))
  }
  return versions
}

// imageRefsOf collects the durable references of every retained image, in
// message order, once per attachment.
//
// Only user messages are read: the harness represents an image in an assistant
// turn by nothing at all, and a reference found anywhere else would be read for
// a request that cannot carry it.
function imageRefsOf(messages) {
  const refs = new Map()
  for (const message of messages || []) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (!block || block.type !== 'image' || block.offloaded === true) continue
      const ref = block.attachment
      if (ref && typeof ref.attachmentId === 'string' && !refs.has(ref.attachmentId)) refs.set(ref.attachmentId, ref)
    }
  }
  return [...refs.values()]
}

// requestTarget scales one image into the route's pixel budget without
// enlarging it and without changing its aspect ratio.
//
// The geometry is the harness's own, repeated here because the plugin is
// installed without the harness packages: the target decides which image the
// provider receives, so a different rule here would silently change the request
// the harness priced.
function requestTarget(ref) {
  const width = Number.isInteger(ref.width) && ref.width > 0 ? ref.width : 1
  const height = Number.isInteger(ref.height) && ref.height > 0 ? ref.height : 1
  const scale = Math.min(1, Math.sqrt(IMAGE_POLICY.maxPixels / (width * height)))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    maxBytes: IMAGE_POLICY.maxBytes,
  }
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
  prepareImages,
  imageRefsOf,
  requestTarget,
  providerRetryAfterMs,
  failureCode,
}
