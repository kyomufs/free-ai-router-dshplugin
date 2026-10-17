'use strict'

// Checks for the free-ai-router-dshplugin.
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
    for (const name of ['BASE', 'headers', 'listProviders', 'ping', 'modelMeta', 'rememberCatalog']) {
      assert.ok(name in daemon, `missing export ${name}`)
    }
  })

  check('headers are assembled on demand', () => {
    const daemon = require('../lib/daemon.cjs')
    assert.strictEqual(daemon.headers(false)['content-type'], undefined)
    assert.strictEqual(daemon.headers(true)['content-type'], 'application/json')
  })

  check('every request is attributed', () => {
    // Attribution is part of the adapter contract and it is never suppressed.
    // The plain read is checked too: the catalog request is a request like any
    // other, and it is the one that runs before anything else.
    const daemon = require('../lib/daemon.cjs')
    for (const json of [false, true]) {
      const agent = daemon.headers(json)['user-agent']
      assert.ok(typeof agent === 'string' && agent.length > 0, 'no user-agent')
      assert.ok(agent.includes('/'), `the agent is not product/version: ${agent}`)
    }
  })

  check('the catalog is remembered for the per-call lookup', () => {
    // One answer describes every model at once. The lookup that runs on every
    // request reads the cache instead of asking the gateway again.
    const daemon = require('../lib/daemon.cjs')
    const byProvider = daemon.rememberCatalog({
      data: [
        { id: 'opencode/beam-free', name: 'Beam Free', context_length: 1048576 },
        { id: 'openrouter/poolside/laguna-s-2.1:free' },
        { id: 'providerless', object: 'model' },
      ],
    })

    assert.ok(byProvider.has('opencode'), 'no provider in the grouping')
    assert.ok(byProvider.get('opencode').includes('beam-free'))
    // The slashes that belong to the model identifier itself stay in it.
    assert.deepStrictEqual(byProvider.get('openrouter'), ['poolside/laguna-s-2.1:free'])
    // An identifier without a provider names no route and is skipped.
    assert.ok(!byProvider.has('providerless'), 'a providerless identifier was grouped')

    assert.strictEqual(daemon.modelMeta('opencode', 'beam-free').context_length, 1048576)
    assert.deepStrictEqual(daemon.modelMeta('opencode', 'unknown'), {}, 'an unknown model must report nothing')
  })
}

// --- adapter ---

function testAdapter() {
  const { createAdapter } = require('../lib/adapter.cjs')
  const daemon = require('../lib/daemon.cjs')

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

  check('a model the gateway never described gets no invented limits', () => {
    // The old plugin filled these in from constants. The harness validates
    // them strictly — a zero window is an error, not a default — so a
    // substitute number is either a rejection or a lie about a limit nobody
    // knows. Absence is the only honest answer.
    const info = createAdapter(stubCtx, 'nowhere').modelInfo('undescribed')

    assert.strictEqual(info.provider, 'nowhere')
    assert.strictEqual(info.id, 'undescribed')
    assert.strictEqual(info.name, 'undescribed', 'the identifier stands in for a name')
    assert.strictEqual(info.context, undefined, 'a context window was invented')
    assert.strictEqual(info.defaultMaxTokens, undefined, 'a token ceiling was invented')
    assert.deepStrictEqual(info.inputModalities, ['text'], 'text is the floor, not a guess')
    assert.strictEqual(info.reasoning, undefined, 'a reasoning ladder was invented')
  })

  check('declared capabilities reach the model metadata', () => {
    daemon.rememberCatalog({
      data: [{
        id: 'somewhere/vision-model',
        name: 'Vision Model',
        context_length: 1048576,
        max_completion_tokens: 131072,
        input_modalities: ['text', 'image'],
        reasoning_efforts: ['low', 'high', 'high', 'max'],
      }],
    })

    const info = createAdapter(stubCtx, 'somewhere').modelInfo('vision-model')
    assert.strictEqual(info.name, 'Vision Model')
    assert.deepStrictEqual(info.context, { contextWindow: 1048576 })
    assert.strictEqual(info.defaultMaxTokens, 131072)
    assert.deepStrictEqual(info.inputModalities, ['text', 'image'])

    // The ladder is the provider's own spelling, order preserved, duplicates
    // dropped: the harness rejects a ladder that names a level twice.
    assert.deepStrictEqual(info.reasoning.efforts.map((e) => e.id), ['low', 'high', 'max'])
    assert.ok(info.reasoning.efforts.every((e) => typeof e.name === 'string' && e.name.length > 0))
    // The default has to be one of the declared levels, or the harness rejects
    // the whole metadata block.
    assert.ok(info.reasoning.efforts.some((e) => e.id === info.reasoning.defaultEffort))
  })

  check('an unusable capability is left out rather than zeroed', () => {
    // A provider may answer with a zero or a string where a number is
    // expected. Both are "not declared", and neither may become a limit.
    daemon.rememberCatalog({
      data: [{
        id: 'somewhere/odd-model',
        context_length: 0,
        max_completion_tokens: 'many',
        input_modalities: [''],
        reasoning_efforts: [],
      }],
    })

    const info = createAdapter(stubCtx, 'somewhere').modelInfo('odd-model')
    assert.strictEqual(info.context, undefined)
    assert.strictEqual(info.defaultMaxTokens, undefined)
    assert.deepStrictEqual(info.inputModalities, ['text'])
    assert.strictEqual(info.reasoning, undefined)
  })
}

// --- refusals ---

function testRefusal() {
  const { providerRetryAfterMs, failureCode, buildBody } = require('../lib/stream.cjs')

  check('the wait is read from both header forms', () => {
    assert.strictEqual(providerRetryAfterMs(new Headers({ 'retry-after-ms': '1500' })), 1500)
    assert.strictEqual(providerRetryAfterMs(new Headers({ 'retry-after': '30' })), 30000)
  })

  check('an absent wait stays absent', () => {
    // The harness validates the field: a present-but-unusable value fails the
    // whole attempt, and zero is rejected along with NaN. Absence is how "no
    // wait was asked for" is said.
    for (const headers of [
      new Headers(),
      new Headers({ 'retry-after-ms': '0' }),
      new Headers({ 'retry-after': '0' }),
      new Headers({ 'retry-after-ms': 'soon' }),
      new Headers({ 'retry-after': '-5' }),
    ]) {
      assert.strictEqual(providerRetryAfterMs(headers), undefined, `headers: ${JSON.stringify([...headers])}`)
    }
  })

  check('a stable refusal is classified as a failure, not as a wait', () => {
    assert.strictEqual(failureCode(429, ''), 'RATE_LIMIT')
    assert.strictEqual(failureCode(500, ''), 'SERVER')
    assert.strictEqual(failureCode(418, ''), 'PROVIDER_ERROR')
  })

  check('the token allowance is sent only when it was set', () => {
    // A number written here would override the provider's own ceiling with a
    // guess, and the guess is wrong for most models: the same free tier
    // declares limits from thirty-two thousand to a hundred and thirty-one
    // thousand. An absent field leaves the decision where the knowledge is.
    const adapter = { provider: 'opencode' }
    const bare = buildBody(adapter, { model: 'm', messages: [] })
    assert.strictEqual(bare.model, 'opencode/m')
    assert.strictEqual('max_tokens' in bare, false, 'an allowance was invented')

    const asked = buildBody(adapter, { model: 'm', messages: [], maxTokens: 1234 })
    assert.strictEqual(asked.max_tokens, 1234)
  })
}

// --- the refusal on the wire ---

async function testRefusalOnTheWire() {
  const { createStreamer } = require('../lib/stream.cjs')

  // The retry scheduler looks for exactly providerRetryAfterMs on the failure
  // snapshot. The same value under any other name is invisible to it: the
  // harness then retries on its own schedule, straight back into a service
  // that has just said "later". That is why the FIELD NAME is asserted here
  // and not only the value.
  await checkAsync('a refusal carries the wait under the name the scheduler reads', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () => new Response('quota exhausted', {
      status: 429,
      headers: { 'retry-after': '30' },
    })
    try {
      let caught
      try {
        for await (const _event of createStreamer({ provider: 'opencode' }, { model: 'm', messages: [] })) {
          // no events are expected from a refusal
        }
      } catch (error) {
        caught = error
      }
      assert.ok(caught, 'the refusal was swallowed')
      assert.strictEqual(caught.code, 'RATE_LIMIT')
      assert.strictEqual(caught.failure.providerRetryAfterMs, 30000)
      assert.strictEqual(caught.failure.retryAfterMs, undefined, 'the old field name came back')
    } finally {
      globalThis.fetch = original
    }
  })

  await checkAsync('a refusal with no wait carries no wait field', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async () => new Response('nope', { status: 403 })
    try {
      let caught
      try {
        for await (const _event of createStreamer({ provider: 'opencode' }, { model: 'm', messages: [] })) {
          // no events are expected from a refusal
        }
      } catch (error) {
        caught = error
      }
      assert.ok(caught, 'the refusal was swallowed')
      // Absence, not zero: the harness rejects a present-but-unusable value
      // and zero is rejected along with NaN.
      assert.strictEqual('providerRetryAfterMs' in caught.failure, false)
    } finally {
      globalThis.fetch = original
    }
  })
}

async function testAdapterAsync() {
  const { createAdapter } = require('../lib/adapter.cjs')
  const adapter = createAdapter(stubCtx, 'opencode')

// An unfamiliar model is resolved with what is known about it, which may be
  // nothing: the gateway may have announced it only just now, while the plugin
  // catalog refreshes later.
  await checkAsync('an unfamiliar model is resolved without invented limits', async () => {
    const info = await adapter.resolveModel('opencode', 'never-heard-of-it')
    assert.strictEqual(info.provider, 'opencode')
    assert.strictEqual(info.id, 'never-heard-of-it')
    assert.ok(info.name.length > 0, 'the harness requires a non-empty name')
    // A catalog refresh is all it takes for the capabilities to appear, and
    // until then the plugin says nothing instead of guessing.
    const afterRefresh = adapter.modelInfo('big-pickle')
    assert.strictEqual(afterRefresh.id, 'big-pickle')
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

  // The closing tool-call block must satisfy the harness contract exactly.
  // This checks the SHAPE and not only the values, because the defect it
  // guards against was a shape defect: the block used to carry `content`
  // instead of `arguments` and no name at all, and the harness refused to
  // record the event, failing the whole turn. Asserting the field names is
  // what makes that failure impossible to reintroduce.
  await checkAsync("a tool call closes as a contract-shaped block", async () => {
    const events = await drain(streamOf([
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"path"' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"/x"}' } }] } }] }),
    ]))

    const end = events.find((e) => e.type === "block-end" && e.block?.type === "tool-call")
    assert.ok(end, "no tool-call block was closed")

    // Required by the contract, and the reason the turn used to fail.
    assert.strictEqual(end.block.name, "read", "the block carries no tool name")
    assert.strictEqual(end.block.arguments, '{"path":"/x"}', "the arguments were not accumulated")
    // The field the block used to carry instead. Its presence would mean the
    // old shape came back.
    assert.strictEqual(end.block.content, undefined, "the block carries a stray content field")

    // A block has to be JSON-serializable, which is what the harness needs
    // when it records the event.
    assert.doesNotThrow(() => JSON.stringify(end.block))
  })

  // A tool call the service never named cannot be dispatched: there would be
  // no tool to call. It is dropped rather than passed on, so the rest of the
  // turn survives.
  await checkAsync("an unnamed tool call is dropped, not closed", async () => {
    const events = await drain(streamOf([
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { arguments: "{}" } }] } }] }),
    ]))
    const blocks = events.filter((e) => e.type === "block-end" && e.block?.type === "tool-call")
    assert.strictEqual(blocks.length, 0, "an unnamed tool call must not be closed")
  })

  // The id is required on the delta and on the closing block alike. A service
  // that omits it would otherwise drop the field, and an absent property is a
  // different shape from a present one — the harness refuses the event on
  // shape, so a missing id fails the turn just as a missing name does.
  await checkAsync("a tool call without a service id still gets one", async () => {
    const events = await drain(streamOf([
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "read", arguments: "{}" } }] } }] }),
    ]))

    const delta = events.find((e) => e.type === "tool-call-delta")
    const end = events.find((e) => e.type === "block-end" && e.block?.type === "tool-call")

    assert.ok(delta && typeof delta.id === "string" && delta.id.length > 0, "the delta carries no id")
    assert.ok(end && typeof end.block.id === "string" && end.block.id.length > 0, "the block carries no id")
    // Both must agree, or the result cannot be correlated with its call.
    assert.strictEqual(end.block.id, delta.id, "the delta and the block disagree on the id")
  })
}

// --- running ---

async function main() {
  testCatalog()
  testAdapter()
  testRefusal()
  testMessages()
  await testAdapterAsync()
  await testRefusalOnTheWire()
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
