'use strict'

// Разбор потока событий от шлюза.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. Разбор потока — единственное место, где плагин
// разбирает ответ построчно, и оно достаточно объёмно, чтобы держаться врозь
// от отправки запроса. Граница проходит по вопросу: здесь только перевод
// кадров, без сети.
//
// ЧТО ВАЖНО. Харнесс ждёт согласованную последовательность блоков: открытие,
// порции, закрытие. Поток от сервиса приходит иначе — плоскими порциями без
// явных границ, — и приведение к последовательности делается здесь.

// CHUNK_LIMIT — предел на размер одной строки кадра.
//
// Нужен, чтобы повреждённый поток не съел память: строка без перевода строки
// копилась бы до исчерпания.
const CHUNK_LIMIT = 4 << 20

// parseSse читает поток и выдаёт события харнесса.
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
        if (frame === null) return // признак конца
        yield* handleFrame(state, frame)
      }

      if (buffer.length > CHUNK_LIMIT) {
        throw new Error('поток: строка кадра превысила предел')
      }
    }
  } finally {
    try { await reader.cancel() } catch { /* поток уже закрыт */ }
    try { reader.releaseLock() } catch { /* освобождать нечего */ }
  }

  yield* closeAll(state)
  if (signal?.aborted) return
  yield { type: 'finish', reason: { kind: state.finishKind || 'stop' } }
}

// newState создаёт состояние разбора.
function newState() {
  return { openKind: null, openIndex: -1, openText: "", openCalls: new Map(), nextIndex: 0, finishKind: null, usageSent: false }
}

// frameOf разбирает одну строку файла.
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
