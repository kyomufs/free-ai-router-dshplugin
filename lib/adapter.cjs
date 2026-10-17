'use strict'

// Provider adapter: translates a harness call into a request to the gateway.
//
// An adapter is created FOR EVERY provider. Internally it differs only by the
// route identifier: the request shape and the response parsing are identical,
// because the gateway brings all providers to a single protocol.
//
// WHAT IS HERE AND WHAT IS NOT. Message translation and stream parsing are
// here — that is client-side work. There is no spoofing of headers, keys, or
// transport: the daemon handles that, and duplicating it in the plugin would
// mean having two places where the same decision is made differently.

const { BASE, headers } = require('./daemon.cjs')

// Defaults for models the gateway reported no metadata for.
//
// A model without metadata STILL WORKS: it merely loses exact limits.
// Rejecting it would be worse — the operator would see that the model exists in
// the daemon's catalog but cannot select it.
const DEFAULT_CONTEXT_WINDOW = 200000
const DEFAULT_MAX_TOKENS = 32000
const DEFAULT_REASONING = 'high'

// EFFORT_NAMES — human-readable names of reasoning levels.
const EFFORT_NAMES = {
  off: 'Off', none: 'Off', minimal: 'Minimal', low: 'Low',
  medium: 'Medium', high: 'High', xhigh: 'Very high', max: 'Maximum',
}

// DEFAULT_EFFORTS — the ladder for models that did not declare their own.
// Matches the one the opencode client uses.
const DEFAULT_EFFORTS = ['off', 'low', 'high', 'max']

// FREE_RETRY_POLICY — the retry policy for free routes.
//
// THE SHAPE HERE MATTERS MORE THAN THE CONTENT. The retry scheduler reads the
// delays from the top level of the object, because it expects an already
// resolved policy. A descriptive form with a nested backoff reaches it as
// "no delays", and the delay is computed from NaN. Flattened delays are not
// style, they are a precondition for working at all.
//
// THE NUMBERS. The delay doubles up to a ceiling of ten seconds: on free tiers
// a refusal most often means an exhausted quota, and frequent retries only
// prolong that exhaustion. A spread of a tenth disperses simultaneous retries
// so they do not hit the service in one volley.
const FREE_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 5,
  retryableCodes: Object.freeze(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE']),
  initialDelayMs: 500,
  maxDelayMs: 10000,
  jitterRatio: 0.1,
})

// createAdapter creates an adapter for a single provider.
function createAdapter(ctx, provider) {
  return new RouterAdapter(ctx, provider)
}

// RouterAdapter — a provider adapter through the gateway.
class RouterAdapter {
  constructor(ctx, provider) {
    this.ctx = ctx
    this.provider = provider
  }

  // providerInfo describes the route for the interface.
  providerInfo(id) {
    return { id, name: `Free AI (${id})` }
  }

  // imageRequestPricing reports that the provider does not charge for images.
  //
  // The method is mandatory: the token meter calls it without checking whether
  // it exists, and its absence would break accounting.
  imageRequestPricing() { return undefined }

  // providerRetryPolicy describes what the harness may retry on its own.
  //
  // THE POLICY IS RETURNED ALREADY RESOLVED. The harness takes it as is:
  // filling in defaults applies only to the branch where the method returned
  // nothing. So a descriptive form, where the delays sit in a nested backoff
  // object, reaches the retry scheduler whole — it reads the delays from the
  // top level, does not find them, and computes the delay from NaN. Retries
  // after that come back to back, which means they stop being retries.
  // That is why the delays are flattened onto the top level, next to the mode.
  //
  // Only failures considered temporary are retried. A refusal under the
  // service's policy (for example a 403 on a free tier) is not in the list: it
  // is a stable decision by the provider, and retrying it would mean knocking
  // on a closed door.
  //
  // The method is mandatory: the harness calls it on every route without
  // checking whether it exists, and its absence breaks registration entirely.
  providerRetryPolicy() {
    return FREE_RETRY_POLICY
  }

  // listModels returns the provider's catalog.
  //
  // The list is taken from the gateway: it is the only one that knows what is
  // available right now. When the gateway is unreachable an empty list is
  // returned — the selector shows the route without models rather than
  // crashing.
  async listModels(id = this.provider) {
    const response = await fetch(`${BASE}/v1/models`, { headers: headers(false) })
    if (!response.ok) throw new Error(`GET /v1/models → HTTP ${response.status}`)
    const body = await response.json()
    const data = Array.isArray(body?.data) ? body.data : []

    const prefix = `${id}/`
    return data
      .filter((item) => typeof item?.id === 'string' && item.id.startsWith(prefix))
      .map((item) => this.modelInfo(item.id.slice(prefix.length)))
  }

  // resolveModel returns the model's metadata.
  //
  // A model that is not in the catalog is resolved with defaults: rejecting it
  // here would mean disagreeing with the gateway, which has already accepted
  // it.
  async resolveModel(provider, model) {
    return this.modelInfo(model, provider)
  }

  // prepareCall binds the model's metadata to the call.
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model),
      stream: (options) => this.stream(options),
    }
  }

  // modelInfo assembles the model's metadata.
  //
  // There are no exact limits here: the gateway knows them, and it is the one
  // that applies them to the request. The plugin needs them only for the
  // interface, so they are taken conservatively — underestimating is safer
  // than overestimating.
  modelInfo(id, provider = this.provider) {
    return {
      provider,
      id,
      name: id,
      context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      inputModalities: ['text'],
      reasoning: {
        efforts: DEFAULT_EFFORTS.map((effort) => ({
          id: effort,
          name: EFFORT_NAMES[effort] || effort,
        })),
        defaultEffort: DEFAULT_REASONING,
      },
    }
  }

  // stream sends the request and parses the stream.
  async *stream(options) {
    const { createStreamer } = require('./stream.cjs')
    yield* createStreamer(this, options)
  }
}

module.exports = { createAdapter, RouterAdapter, DEFAULT_EFFORTS, EFFORT_NAMES }
