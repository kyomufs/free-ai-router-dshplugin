'use strict'

// Отправка запроса и разбор потока.
//
// ЧТО ЗДЕСЬ ПРОИСХОДИТ. Плагин переводит сообщения харнесса в форму запроса,
// отправляет его шлюзу и переводит обратно поток событий. Форма запроса —
// самая обычная, OpenAI-совместимая: шлюз приводит к ней всех провайдеров, и
// клиентской стороне не нужно знать, кто отвечает на том конце.
//
// ЧЕГО ЗДЕСЬ НЕТ: повторов, подмены заголовков, выбора транспорта, обхода
// проверок. Всё это делает шлюз, и дублирование здесь означало бы два места,
// где одно решение принимается по-разному.

const { BASE, headers } = require('./daemon.cjs')
const { parseSse } = require('./sse.cjs')

// MAX_TOKENS_FALLBACK — предел ответа, когда вызывающий его не задал.
const MAX_TOKENS_FALLBACK = 32000

// createStreamer создаёт генератор событий для одного запроса.
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
    // Соединение не состоялось. Это транспортный сбой, а не отказ провайдера:
    // клиент должен видеть разницу.
    throw typedError(`шлюз недоступен: ${errorText(error)}`, 'TRANSPORT')
  }

  if (!response.ok) {
    // Отказ передаётся ДОСЛОВНО. Шлюз уже позаботился о том, чтобы тело,
    // статус и заголовки совпадали с ответом сервиса; разбирать их здесь
    // значило бы потерять признаки, по которым харнесс решает, повторять ли
    // запрос.
    const detail = await response.text().catch(() => '')
    const status = response.status
    throw typedError(
      `шлюз ответил HTTP ${status}: ${detail.slice(0, 300)}`,
      failureCode(status, detail),
      { status, retryAfterMs: retryAfterMs(response.headers) },
    )
  }

  let sawContent = false
  for await (const event of parseSse(response, signal)) {
    if (event.type !== 'usage' && event.type !== 'finish') sawContent = true
    yield event
  }

  if (signal?.aborted) return
  if (!sawContent) {
    throw typedError('шлюз завершил поток без содержимого', 'EMPTY_RESPONSE')
  }
}

// buildBody собирает тело запроса.
function buildBody(adapter, options) {
  const body = {
    // Идентификатор составной: шлюз по нему понимает, к какому провайдеру
    // адресован запрос.
    model: `${adapter.provider}/${options.model}`,
    messages: serializeMessages(options.messages, options.system),
    stream: true,
  }
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  else body.max_tokens = MAX_TOKENS_FALLBACK
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.reasoningEffort !== undefined) body.reasoning_effort = options.reasoningEffort

  const tools = serializeTools(options.tools)
  if (tools) body.tools = tools
  return body
}

// serializeMessages переводит сообщения харнесса в форму запроса.
//
// Системная часть идёт отдельным сообщением: так её ждёт шлюз, который
// передаёт её провайдеру отдельно от истории.
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

// flattenText собирает текст из содержимого сообщения.
function flattenText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

// reasoningOf собирает размышления ассистента.
function reasoningOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'reasoning' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

// toolCallsOf собирает вызовы инструментов.
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

// serializeTools переводит объявления инструментов.
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




// typedError создаёт ошибку с кодом и снимком отказа.
//
// Харнесс различает отказы по полю code и по снимку failure. Без обоих он
// не видит отказ и не применяет свою политику повторов.
function typedError(message, code, extra = {}) {
  const error = new Error(message)
  error.code = code
  error.failure = { message, code, ...extra }
  return error
}


// errorText собирает цепочку причин из цепочки ошибок.
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

// failureCode выбирает код отказа в общем виде.
//
// Коды совпадают с теми, что различает харнесс. Отказ в доступе (403) НЕ
// считается отказом в ключе: у провайдеров он означает и запрет по региону, и
// исчерпанное право, и ключ тут ни при чём.
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

// retryAfterMs читает срок ожидания из заголовков.
//
// Порядок тот же, что у харнесса: сначала миллисекундный заголовок, затем
// секунды. Значение нужно, чтобы харнесс мог подождать столько, сколько
// просит сервис, а не по своему обычному расписанию.
function retryAfterMs(headers) {
  const ms = Number(headers.get("retry-after-ms"))
  if (Number.isFinite(ms)) return Math.max(0, ms)
  const seconds = Number(headers.get("retry-after"))
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  return undefined
}

module.exports = { createStreamer, serializeMessages, serializeTools }
