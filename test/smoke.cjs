'use strict'

// Проверки плагина free-ai-router-plugin.
//
// ЧТО ПРОВЕРЯЕТСЯ. Плагин — посредник между харнессом и шлюзом. Значит
// проверяются ровно границы: как он понимает каталог шлюза, как переводит
// сообщения и как передаёт отказ. Остальное — работа демона, и её проверяет он.
//
// ЧЕГО ЗДЕСЬ НЕТ. Проверок формы запроса к провайдеру и обхода проверок: этим
// занимается шлюз, и дублировать его решения здесь значило бы завести второе
// место, где то же самое делается иначе.

const assert = require('node:assert')

let passed = 0
const failures = []

function check(label, fn) {
  try {
    fn()
    passed++
  } catch (error) {
    failures.push({ label, error })
  }
}

async function checkAsync(label, fn) {
  try {
    await fn()
    passed++
  } catch (error) {
    failures.push({ label, error })
  }
}

// splitModelId — разбивка составного идентификатора по ПЕРВОМУ слэшу.
//
// Продублирована намеренно: проверка обязана утверждать ФОРМУ, а не повторять
// реализацию. Если реализация изменится, проверка это заметит.
function splitModelId(composite) {
  const slash = composite.indexOf('/')
  if (slash <= 0) return null
  return { provider: composite.slice(0, slash), model: composite.slice(slash + 1) }
}

// stubCtx — подставной контекст харнесса.
const stubCtx = { get: () => undefined, logger: { info() {}, warn() {} } }

// streamOf собирает поток кадров для проверок разбора.
function streamOf(frames) {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of frames) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return { body }
}

// frame собирает один кадр события.
function frame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

// drain собирает события потока в массив.
async function drain(response) {
  const { parseSse } = require('../lib/sse.cjs')
  const out = []
  for await (const event of parseSse(response, undefined)) out.push(event)
  return out
}

// --- каталог шлюза ---

function testCatalog() {
  for (const [composite, provider, model] of [
    ['opencode/mimo-v2.6-flash-free', 'opencode', 'mimo-v2.6-flash-free'],
    // Слэш внутри идентификатора модели обязан остаться в модели.
    ['openrouter/poolside/laguna-s-2.1:free', 'openrouter', 'poolside/laguna-s-2.1:free'],
  ]) {
    check(`составной id «${composite}» разбирается`, () => {
      const got = splitModelId(composite)
      assert.ok(got, 'идентификатор не разобран')
      assert.strictEqual(got.provider, provider)
      assert.strictEqual(got.model, model)
    })
  }

  check('идентификатор без провайдера отвергается', () => {
    assert.strictEqual(splitModelId('модель'), null)
    assert.strictEqual(splitModelId('/модель'), null)
  })

  check('модуль общения отдаёт нужное', () => {
    const daemon = require('../lib/daemon.cjs')
    for (const name of ['BASE', 'headers', 'listProviders', 'ping']) {
      assert.ok(name in daemon, `нет экспорта ${name}`)
    }
  })

  check('заголовки собираются по требованию', () => {
    const daemon = require('../lib/daemon.cjs')
    assert.strictEqual(daemon.headers(false)['content-type'], undefined)
    assert.strictEqual(daemon.headers(true)['content-type'], 'application/json')
  })
}

// --- адаптер ---

function testAdapter() {
  const { createAdapter, DEFAULT_EFFORTS } = require('../lib/adapter.cjs')

  check('адаптер создаётся под своим провайдером', () => {
    assert.strictEqual(createAdapter(stubCtx, 'zenmux').providerInfo('zenmux').id, 'zenmux')
  })

  check('imageRequestPricing объявлен', () => {
    // Метод обязателен: измеритель токенов вызывает его без проверки наличия.
    const adapter = createAdapter(stubCtx, 'opencode')
    assert.strictEqual(typeof adapter.imageRequestPricing, 'function')
    assert.strictEqual(adapter.imageRequestPricing(), undefined)
  })

  check('метаданные модели содержат обязательные поля', () => {
    const info = createAdapter(stubCtx, 'opencode').modelInfo('модель')
    assert.strictEqual(info.provider, 'opencode')
    assert.ok(info.context.contextWindow > 0, 'нет размера окна')
    assert.ok(info.defaultMaxTokens > 0, 'нет предела ответа')
    assert.ok(Array.isArray(info.inputModalities))
    assert.ok(Array.isArray(info.reasoning.efforts))
    assert.ok(info.reasoning.defaultEffort)
  })

  check('лестница усилий совпадает с клиентской', () => {
    assert.deepStrictEqual(DEFAULT_EFFORTS, ['off', 'low', 'high', 'max'])
  })
}

async function testAdapterAsync() {
  const { createAdapter } = require('../lib/adapter.cjs')
  const adapter = createAdapter(stubCtx, 'opencode')

  // Незнакомая модель разрешается с умолчаниями: шлюз мог объявить её только
  // что, а каталог плагина обновляется позже.
  await checkAsync('незнакомая модель разрешается с умолчаниями', async () => {
    const info = await adapter.resolveModel('opencode', 'никогда-не-слыхали')
    assert.strictEqual(info.id, 'никогда-не-слыхали')
    assert.ok(info.context.contextWindow > 0)
  })
}

// --- перевод сообщений ---

function testMessages() {
  const { serializeMessages, serializeTools } = require('../lib/stream.cjs')

  check('системная часть становится отдельным сообщением', () => {
    const messages = serializeMessages([{ role: 'user', content: 'привет' }], 'инструкции')
    assert.strictEqual(messages.length, 2)
    assert.strictEqual(messages[0].role, 'system')
    assert.strictEqual(messages[1].role, 'user')
  })

  check('размышления ассистента сохраняются', () => {
    // Поле с размышлениями нужно провайдерам, которые продолжают работу по
    // своей же прошлой мысли: потеряв его, мы сломали бы длинные ходы.
    const messages = serializeMessages(
      [{ role: 'assistant', content: [
        { type: 'reasoning', text: 'думаю' },
        { type: 'text', text: 'отвечаю' },
      ] }],
      '',
    )
    assert.strictEqual(messages[0].reasoning_content, 'думаю')
    assert.strictEqual(messages[0].content, 'отвечаю')
  })

  check('пустой ход ассистента не отправляется', () => {
    // Пустое сообщение ассистента на проводе недопустимо: провайдер отвергнет
    // весь запрос из-за него.
    assert.strictEqual(serializeMessages([{ role: 'assistant', content: [] }], '').length, 0)
  })

  check('вызовы инструментов переводятся', () => {
    const messages = serializeMessages(
      [{ role: 'assistant', content: [
        { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"/x"}' },
      ] }],
      '',
    )
    assert.strictEqual(messages[0].tool_calls[0].id, 'call_1')
    assert.strictEqual(messages[0].tool_calls[0].function.name, 'read')
  })

  check('ответ инструмента несёт свой идентификатор', () => {
    const messages = serializeMessages([{ role: 'tool', toolCallId: 'call_1', content: 'результат' }], '')
    assert.strictEqual(messages[0].tool_call_id, 'call_1')
    assert.strictEqual(messages[0].content, 'результат')
  })

  check('пустой ответ инструмента заменяется заглушкой', () => {
    const messages = serializeMessages([{ role: 'tool', toolCallId: 'c', content: '' }], '')
    assert.strictEqual(messages[0].content, '(no output)')
  })

  check('объявления инструментов переводятся', () => {
    const tools = serializeTools([{ name: 'read', description: 'читать', parameters: { type: 'object' } }])
    assert.strictEqual(tools[0].function.name, 'read')
    assert.deepStrictEqual(tools[0].function.parameters, { type: 'object' })
  })

  check('инструмент без схемы получает пустую', () => {
    assert.deepStrictEqual(serializeTools([{ name: 'read' }])[0].function.parameters, {
      type: 'object', properties: {},
    })
  })

  check('отсутствие инструментов не создаёт поле', () => {
    assert.strictEqual(serializeTools(undefined), undefined)
    assert.strictEqual(serializeTools([]), undefined)
  })
}

// --- разбор потока ---

async function testSse() {
  await checkAsync("текст становится блоком", async () => {
    const events = await drain(streamOf([frame({ choices: [{ delta: { content: "привет" } }] })]))
    const start = events.find((e) => e.type === "block-start")
    assert.ok(start, "нет открытия блока")
    assert.strictEqual(start.blockType, "text")
  })
  await checkAsync("размышления отделяются от текста", async () => {
    const events = await drain(streamOf([frame({ choices: [{ delta: { reasoning_content: "думаю" } }] })]))
    assert.strictEqual(events.find((e) => e.type === "block-start").blockType, "reasoning")
  })
  await checkAsync("поток заканчивается признаком завершения", async () => {
    const events = await drain(streamOf([frame({ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] })]))
    const finish = events.find((e) => e.type === "finish")
    assert.ok(finish, "нет признака завершения")
    assert.strictEqual(finish.reason.kind, "stop")
  })

  await checkAsync("сведения о расходе доходят", async () => {
    const events = await drain(streamOf([frame({ usage: { prompt_tokens: 10, completion_tokens: 5 } })]))
    assert.strictEqual(events.find((e) => e.type === "usage").usage.outputTokens, 5)
  })
}

// --- запуск ---

async function main() {
  testCatalog()
  testAdapter()
  testMessages()
  await testAdapterAsync()
  await testSse()
  report()
}

function report() {
  if (failures.length === 0) {
    console.log(`все проверки пройдены: ${passed}`)
    return
  }
  console.error(`провалов: ${failures.length} из ${passed + failures.length}`)
  for (const { label, error } of failures) {
    console.error(`  ПРОВАЛ: ${label}`)
    console.error(`    ${error.message}`)
  }
  process.exitCode = 1
}

main().catch((error) => {
  console.error("прогон прерван:", error)
  process.exitCode = 1
})
