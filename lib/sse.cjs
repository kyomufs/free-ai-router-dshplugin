'use strict'

// Parsing the event stream from the gateway.
//
// WHY A SEPARATE FILE. Stream parsing is the only place where the plugin parses
// the response line by line, and it is large enough to be kept apart from
// sending the request. The boundary runs along the question: only frame
// translation happens here, without network.
//
// WHAT MATTERS. The harness expects a consistent block sequence: opening,
// deltas, closing. The stream from the service arrives differently — as flat
// chunks without explicit boundaries — and bringing it to that sequence is done
// here.

// CHUNK_LIMIT — the limit on the size of a single frame line.
//
// It is needed so that a corrupted stream does not eat memory: a line without a
// newline would accumulate until exhaustion.
const CHUNK_LIMIT = 4 << 20

// parseSse reads the stream and yields harness events.
async function* parseSse(response, signal) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const state = newState()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        const frame = frameOf(line)
        if (frame === undefined) continue
        if (frame === null) return // end marker
        yield* handleFrame(state, frame)
      }

      if (buffer.length > CHUNK_LIMIT) {
        throw new Error('stream: frame line exceeded the limit')
      }
    }
  } finally {
    try { await reader.cancel() } catch { /* stream already closed */ }
    try { reader.releaseLock() } catch { /* nothing to release */ }
  }

  yield* closeAll(state)
  if (signal?.aborted) return
  yield { type: 'finish', reason: { kind: state.finishKind || 'stop' } }
}

// newState creates the parsing state.
function newState() {
  return { openKind: null, openIndex: -1, openText: "", openCalls: new Map(), nextIndex: 0, finishKind: null, usageSent: false }
}

// frameOf parses a single line of the file.
function frameOf(line) {
  if (!line.startsWith("data:")) return undefined
  const data = line.slice(5).trim()
  if (!data) return undefined
  if (data === "[DONE]") return null
  try { return JSON.parse(data) } catch { return undefined }
}

function* handleFrame(state, frame) {
  const out = []
  if (!state.usageSent && frame?.usage && typeof frame.usage === "object") {
    const raw = frame.usage
    const cached = raw.prompt_tokens_details?.cached_tokens || 0
    out.push({
      type: "usage",
      usage: {
        inputTokens: Math.max(0, (raw.prompt_tokens || 0) - cached),
        outputTokens: raw.completion_tokens || 0,
        ...(typeof raw.total_tokens === "number" ? { totalTokens: raw.total_tokens } : {}),
        ...(cached > 0 ? { cacheReadTokens: cached } : {}),
      },
    })
    state.usageSent = true
  }
  if (Array.isArray(frame?.choices) && frame.choices[0]) {
    yield* handleChoice(state, frame.choices[0])
  }
  yield* out
}

function* handleChoice(state, choice) {
  const delta = choice.delta || {}
  for (const [kind, text] of [["reasoning", delta.reasoning_content], ["text", delta.content]]) {
    if (typeof text !== "string" || !text) continue
    yield* openBlock(state, kind)
    state.openText += text
    yield { type: `${kind}-delta`, index: state.openIndex, text }
  }
  for (const call of delta.tool_calls || []) {
    yield* handleToolCall(state, call)
  }
  if (choice.finish_reason) {
    yield* closeOpen(state)
    state.finishKind = { stop: "stop", length: "max-tokens", tool_calls: "tool-calls" }[choice.finish_reason] || "stop"
  }
}

function* openBlock(state, kind) {
  if (state.openKind === kind) return
  yield* closeOpen(state)
  state.openIndex = state.nextIndex++
  state.openText = ""
  state.openCalls = new Map()
  state.openKind = kind
  yield { type: "block-start", index: state.openIndex, blockType: kind }
}

function* closeOpen(state) {
  if (!state.openKind) return
  const kind = state.openKind
  const index = state.openIndex
  if (kind === "tool-call") {
    for (const call of state.openCalls.values()) {
      yield { type: "block-end", index, block: call ? { type: "tool-call", id: call.id, content: call.args } : { type: "tool-call", content: "" } }
    }
  } else {
    yield { type: "block-end", index, block: { type: kind, text: state.openText } }
  }
  state.openKind = null
  state.openIndex = -1
}

function* handleToolCall(state, call) {
  yield* openBlock(state, "tool-call")
  const key = typeof call.index === "number" ? call.index : state.openCalls.size
  const current = state.openCalls.get(key) || { id: call.id, name: call.function?.name, args: "" }
  if (call.function?.arguments) current.args += call.function.arguments
  if (call.function?.name) current.name = call.function.name
  if (call.id) current.id = call.id
  state.openCalls.set(key, current)
  yield {
    type: "tool-call-delta",
    index: state.openIndex,
    id: current.id,
    argumentsDelta: call.function?.arguments || "",
    ...(call.function?.name ? { name: call.function.name } : {}),
  }
}

function* closeAll(state) {
  yield* closeOpen(state)
}

module.exports = { parseSse }
