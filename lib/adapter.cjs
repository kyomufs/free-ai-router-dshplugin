'use strict'

// Provider adapter: translates a harness call into a request to the gateway.
//
// An adapter is created FOR EVERY provider. Internally it differs only by the
// route identifier: the request shape and the response parsing are identical,
// because the gateway brings all providers to a single protocol.
//
// WHAT IS HERE AND WHAT IS NOT. Message translation, the model capabilities and
// stream parsing are here — that is client-side work. There is no spoofing of
// headers, keys, or transport: the daemon handles that, and duplicating it in
// the plugin would mean having two places where the same decision is made
// differently.

const { BASE, headers, modelMeta, rememberCatalog } = require('./daemon.cjs')

// EFFORT_NAMES — human-readable labels for the reasoning levels the provider
// declares. The labels exist for the selector, which shows words to a person;
// the identifiers themselves are passed through untouched, because they are the
// provider's own spelling.
const EFFORT_NAMES = {
  none: 'Off', off: 'Off', minimal: 'Minimal', low: 'Low',
  medium: 'Medium', high: 'High', xhigh: 'Very high', max: 'Maximum',
}

// PREFERRED_DEFAULT_EFFORTS — the order in which a default level is chosen when
// the provider allows several.
//
// This is a preference, not an invention: every candidate is a level the
// provider declared, and the first one that exists wins. Thinking is switched
// on by default because a model that reasons and is asked nothing produces more
// useful answers than one that is silently muted.
const PREFERRED_DEFAULT_EFFORTS = ['high', 'medium', 'low']

// FREE_RETRY_POLICY — the retry policy for free routes.
//
// THE SHAPE HERE MATTERS MORE THAN THE CONTENT. The retry scheduler reads the
// delays from the top level of the object, because it expects an already
// resolved policy. A descriptive form with a nested backoff reaches it as
// "no delays", and the delay is computed from NaN. Flattened delays are not
// style, they are a precondition for working at all.
//
// THE NUMBERS. The delay doubles from half a second up to a ceiling of fifteen
// minutes. The ceiling is deliberately far above the usual "retry in a second"
// range, because of how the scheduler treats a provider-supplied wait: a wait
// longer than maxDelayMs aborts the attempt instead of waiting. A free tier
// that answers "come back in ten minutes" is exactly the case worth waiting
// out — the quota returns by itself — whereas a low ceiling turns that same
// answer into a failure the operator has to work around by hand.
//
// A spread of a tenth disperses simultaneous retries so they do not hit the
// service in one volley.
const FREE_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 5,
  retryableCodes: Object.freeze(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE']),
  initialDelayMs: 500,
  maxDelayMs: 900000,
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

    // The answer is remembered as a whole: the same document carries the
    // capabilities, and the per-call metadata lookup reads them from the cache
    // instead of asking the gateway again on every request.
    rememberCatalog(body)

    const prefix = `${id}/`
    return (Array.isArray(body?.data) ? body.data : [])
      .filter((item) => typeof item?.id === 'string' && item.id.startsWith(prefix))
      .map((item) => this.modelInfo(item.id.slice(prefix.length), id))
  }

  // resolveModel returns the model's metadata.
  //
  // A model that the catalog did not describe is resolved with what is known
  // about it, which may be nothing: rejecting it here would mean disagreeing
  // with the gateway, which has already accepted the request.
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
  // EVERY FIELD IS OPTIONAL AND EVERY FIELD IS TAKEN FROM THE GATEWAY. The
  // capacities are reported by /v1/models, and this method only renames what
  // the gateway already said. What the gateway did not declare is OMITTED, not
  // filled in: the harness validates these fields strictly (a zero window is an
  // error, not a default), so a substitute number is either an error or a lie
  // about a limit nobody knows. An absent field leaves the decision to the
  // harness, which is honest about not knowing.
  modelInfo(id, provider = this.provider) {
    const meta = modelMeta(provider, id)

    const info = {
      provider,
      id,
      name: typeof meta.name === 'string' && meta.name.length > 0 ? meta.name : id,
    }

    if (Number.isInteger(meta.context_length) && meta.context_length > 0) {
      info.context = { contextWindow: meta.context_length }
    }
    if (Number.isInteger(meta.max_completion_tokens) && meta.max_completion_tokens > 0) {
      info.defaultMaxTokens = meta.max_completion_tokens
    }

    const modalities = Array.isArray(meta.input_modalities)
      ? meta.input_modalities.filter((value) => typeof value === 'string' && value.length > 0)
      : []
    info.inputModalities = modalities.length > 0 ? modalities : ['text']

    // The reasoning ladder is the provider's. An empty ladder means the model
    // declared no way to control its thinking, and then the field is left out
    // entirely: the harness rejects a reasoning block with no levels, and
    // offering levels the provider never declared means sending words it may
    // not accept.
    const efforts = dedupe(
      Array.isArray(meta.reasoning_efforts)
        ? meta.reasoning_efforts.filter((value) => typeof value === 'string' && value.length > 0)
        : [],
    )
    if (efforts.length > 0) {
      const chosen = PREFERRED_DEFAULT_EFFORTS.find((effort) => efforts.includes(effort))
      info.reasoning = {
        efforts: efforts.map((effort) => ({ id: effort, name: EFFORT_NAMES[effort] || effort })),
        ...chosen ? { defaultEffort: chosen } : {},
      }
    }

    return info
  }

  // stream sends the request and parses the stream.
  async *stream(options) {
    const { createStreamer } = require('./stream.cjs')
    yield* createStreamer(this, options)
  }
}

// dedupe removes repeated values while keeping the order.
//
// The order is the provider's, because the ladder is shown to a person in the
// order the provider declared it. Duplicates are dropped because the harness
// rejects a ladder that names the same level twice.
function dedupe(values) {
  return [...new Set(values)]
}

module.exports = { createAdapter, RouterAdapter, EFFORT_NAMES }
