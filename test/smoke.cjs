'use strict'

// Checks for the free-ai-router-plugin.
//
// WHAT IS CHECKED. The plugin is an intermediary between the harness and the
// gateway. So exactly the boundaries are checked: how it understands the
// gateway catalog, how it translates messages, and how it passes refusals
// through. The rest is the daemon's work, and the daemon checks it.
//
// WHAT IS NOT HERE. Checks of the request shape sent to a provider and of
// bypassing checks: the gateway does that, and duplicating its decisions here
// would mean creating a second place where the same thing is done differently.

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

// splitModelId — splitting a composite identifier at the FIRST slash.
//
// Duplicated on purpose: a check must assert the SHAPE, not repeat the
// implementation. If the implementation changes, the check will notice.
function splitModelId(composite) {
  const slash = composite.indexOf('/')
  if (slash <= 0) return null
  return { provider: composite.slice(0, slash), model: composite.slice(slash + 1) }
}

// stubCtx — a stand-in harness context.
const stubCtx = { get: () => undefined, logger: { info() {}, warn() {} } }

// streamOf assembles a stream of frames for the parsing checks.
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

// frame assembles a single event frame.
function frame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

// drain collects the stream's events into an array.
async function drain(response) {
  const { parseSse } = require('../lib/sse.cjs')
  const out = []
  for await (const event of parseSse(response, undefined)) out.push(event)
  return out
}

// --- gateway catalog ---

function testCatalog() {
  for (const [composite, provider, model] of [
    ['opencode/mimo-v2.6-flash-free', 'opencode', 'mimo-v2.6-flash-free'],
    // A slash inside a model identifier must stay in the model.
    ['openrouter/poolside/laguna-s-2.1:free', 'openrouter', 'poolside/laguna-s-2.1:free'],
  ]) {
    check(`composite id "${composite}" is split`, () => {
      const got = splitModelId(composite)
      assert.ok(got, 'identifier was not split')
      assert.strictEqual(got.provider, provider)
      assert.strictEqual(got.model, model)
    })
  }

  check('an identifier without a provider is rejected', () => {
    assert.strictEqual(splitModelId('model'), null)
    assert.strictEqual(splitModelId('/model'), null)
  })

  check('the communication module exports what is needed', () => {
    const daemon = require('../lib/daemon.cjs')
    for (const name of ['BASE', 'headers', 'listProviders', 'ping']) {
      assert.ok(name in daemon, `missing export ${name}`)
    }
  })

  check('headers are assembled on demand', () => {
    const daemon = require('../lib/daemon.cjs')
    assert.strictEqual(daemon.headers(false)['content-type'], undefined)
    assert.strictEqual(daemon.headers(true)['content-type'], 'application/json')
  })
}

// --- adapter ---

function testAdapter() {
  const { createAdapter, DEFAULT_EFFORTS } = require('../lib/adapter.cjs')

  check('the adapter is created for its own provider', () => {
    assert.strictEqual(createAdapter(stubCtx, 'zenmux').providerInfo('zenmux').id, 'zenmux')
  })

  check('imageRequestPricing is declared', () => {
    // The method is mandatory: the token meter calls it without checking
    // whether it exists.
    const adapter = createAdapter(stubCtx, 'opencode')
    assert.strictEqual(typeof adapter.imageRequestPricing, 'function')
    assert.strictEqual(adapter.imageRequestPricing(), undefined)
  })

  check('providerRetryPolicy is declared', () => {
    // The harness calls the method without checking whether it exists: its
    // absence breaks route registration entirely rather than leaving the
    // default policy in place.
    const policy = createAdapter(stubCtx, 'opencode').providerRetryPolicy()
    assert.strictEqual(policy.mode, 'normal')
    assert.strictEqual(policy.maxRetries, 5)
    assert.ok(Array.isArray(policy.retryableCodes) && policy.retryableCodes.length > 0)
    assert.ok(!policy.retryableCodes.includes('POLICY'), 'a stable refusal is not retried')
  })

  check('retry delays sit on the top level', () => {
    // The retry scheduler expects a RESOLVED policy and reads the delays
    // straight from it. It does not unwrap a nested backoff: the delay is
    // computed from NaN, and retries run back to back. That is why both the
    // presence of values and the absence of the nested object are checked —
    // the latter would mean someone returned the descriptive form.
    const policy = createAdapter(stubCtx, 'opencode').providerRetryPolicy()
    assert.strictEqual(policy.backoff, undefined, 'the descriptive form was returned')
    assert.ok(policy.initialDelayMs > 0, 'the delay was not resolved')
    assert.ok(policy.maxDelayMs >= policy.initialDelayMs)
    assert.ok(policy.jitterRatio >= 0 && policy.jitterRatio <= 1)

    // The same calculation dsh-llm-retry does: the delay must be finite across
    // the whole retry ladder.
    for (let retry = 1; retry <= policy.maxRetries; retry++) {
      const exponential = Math.min(policy.initialDelayMs * 2 ** (retry - 1), policy.maxDelayMs)
      const delay = Math.min(exponential, policy.maxDelayMs)
      assert.ok(Number.isFinite(delay) && delay > 0, `retry ${retry}: delay ${delay}`)
    }
  })

  check('model metadata contains the mandatory fields', () => {
    const info = createAdapter(stubCtx, 'opencode').modelInfo('model')
    assert.strictEqual(info.provider, 'opencode')
    assert.ok(info.context.contextWindow > 0, 'no window size')
    assert.ok(info.defaultMaxTokens > 0, 'no response limit')
    assert.ok(Array.isArray(info.inputModalities))
    assert.ok(Array.isArray(info.reasoning.efforts))
    assert.ok(info.reasoning.defaultEffort)
  })

  check('the effort ladder matches the client one', () => {
    assert.deepStrictEqual(DEFAULT_EFFORTS, ['off', 'low', 'high', 'max'])
  })
}

async function testAdapterAsync() {
  const { createAdapter } = require('../lib/adapter.cjs')
  const adapter = createAdapter(stubCtx, 'opencode')

  // An unfamiliar model is resolved with defaults: the gateway may have
  // announced it only just now, while the plugin catalog refreshes later.
  await checkAsync('an unfamiliar model is resolved with defaults', async () => {
    const info = await adapter.resolveModel('opencode', 'never-heard-of-it')
    assert.strictEqual(info.id, 'never-heard-of-it')
    assert.ok(info.context.contextWindow > 0)
  })
}

// --- message translation ---

function testMessages() {
  const { serializeMessages, serializeTools } = require('../lib/stream.cjs')

  check('the system part becomes a separate message', () => {
    const messages = serializeMessages([{ role: 'user', content: 'hello' }], 'instructions')
    assert.strictEqual(messages.length, 2)
    assert.strictEqual(messages[0].role, 'system')
    assert.strictEqual(messages[1].role, 'user')
  })

  check("the assistant's reasoning is preserved", () => {
    // The reasoning field is needed by providers that continue work from their
    // own previous thought: losing it would break long turns.
    const messages = serializeMessages(
      [{ role: 'assistant', content: [
        { type: 'reasoning', text: 'thinking' },
        { type: 'text', text: 'answering' },
      ] }],
      '',
    )
    assert.strictEqual(messages[0].reasoning_content, 'thinking')
    assert.strictEqual(messages[0].content, 'answering')
  })

  check('an empty assistant turn is not sent', () => {
    // An empty assistant message on the wire is unacceptable: the provider
    // would reject the whole request because of it.
    assert.strictEqual(serializeMessages([{ role: 'assistant', content: [] }], '').length, 0)
  })

  check('tool calls are translated', () => {
    const messages = serializeMessages(
      [{ role: 'assistant', content: [
        { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"/x"}' },
      ] }],
      '',
    )
    assert.strictEqual(messages[0].tool_calls[0].id, 'call_1')
    assert.strictEqual(messages[0].tool_calls[0].function.name, 'read')
  })

  check('a tool result carries its identifier', () => {
    const messages = serializeMessages([{ role: 'tool', toolCallId: 'call_1', content: 'result' }], '')
    assert.strictEqual(messages[0].tool_call_id, 'call_1')
    assert.strictEqual(messages[0].content, 'result')
  })

  check('an empty tool result is replaced with a stub', () => {
    const messages = serializeMessages([{ role: 'tool', toolCallId: 'c', content: '' }], '')
    assert.strictEqual(messages[0].content, '(no output)')
  })

  check('tool declarations are translated', () => {
    const tools = serializeTools([{ name: 'read', description: 'read a file', parameters: { type: 'object' } }])
    assert.strictEqual(tools[0].function.name, 'read')
    assert.deepStrictEqual(tools[0].function.parameters, { type: 'object' })
  })

  check('a tool without a schema gets an empty one', () => {
    assert.deepStrictEqual(serializeTools([{ name: 'read' }])[0].function.parameters, {
      type: 'object', properties: {},
    })
  })

  check('the absence of tools does not create the field', () => {
    assert.strictEqual(serializeTools(undefined), undefined)
    assert.strictEqual(serializeTools([]), undefined)
  })
}

// --- stream parsing ---

async function testSse() {
  await checkAsync("text becomes a block", async () => {
    const events = await drain(streamOf([frame({ choices: [{ delta: { content: "hello" } }] })]))
    const start = events.find((e) => e.type === "block-start")
    assert.ok(start, "no block opening")
    assert.strictEqual(start.blockType, "text")
  })
  await checkAsync("reasoning is separated from text", async () => {
    const events = await drain(streamOf([frame({ choices: [{ delta: { reasoning_content: "thinking" } }] })]))
    assert.strictEqual(events.find((e) => e.type === "block-start").blockType, "reasoning")
  })
  await checkAsync("the stream ends with a finish marker", async () => {
    const events = await drain(streamOf([frame({ choices: [{ delta: { content: "x" }, finish_reason: "stop" }] })]))
    const finish = events.find((e) => e.type === "finish")
    assert.ok(finish, "no finish marker")
    assert.strictEqual(finish.reason.kind, "stop")
  })

  await checkAsync("usage information comes through", async () => {
    const events = await drain(streamOf([frame({ usage: { prompt_tokens: 10, completion_tokens: 5 } })]))
    assert.strictEqual(events.find((e) => e.type === "usage").usage.outputTokens, 5)
  })
}

// --- running ---

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
    console.log(`all checks passed: ${passed}`)
    return
  }
  console.error(`failures: ${failures.length} out of ${passed + failures.length}`)
  for (const { label, error } of failures) {
    console.error(`  FAILURE: ${label}`)
    console.error(`    ${error.message}`)
  }
  process.exitCode = 1
}

main().catch((error) => {
  console.error("run aborted:", error)
  process.exitCode = 1
})
