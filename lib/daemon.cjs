'use strict'

// Communication with the free-ai-router daemon.
//
// Everything the plugin knows about the gateway is collected here: the address,
// the token, the headers, the list of providers, models, and their capacities.
// The rest of the plugin's code works with already resolved values and knows
// nothing about the transport.

// BASE — the gateway address WITHOUT a path: the plugin appends /v1/... itself.
// A path in the constant would lead to a double prefix when the API version
// changes.
const BASE = process.env.FREE_AI_ROUTER_BASE || 'http://127.0.0.1:8787'

// TOKEN — the shared secret for server mode.
//
// This is a DIFFERENT secret from a provider key. A key opens access to the
// service, the token — to our gateway. Mixing them up, we would either send a
// provider key outside or present our token to a third-party service.
//
// An empty value is normal for local mode: nobody but this machine can reach a
// loopback listener, and the token is not checked.
const TOKEN = process.env.FREE_AI_ROUTER_TOKEN || ''

// Catalog read timeout. The catalog is needed to register routes, but its
// absence must not delay startup: the plugin will register what it already
// knows.
//
// THE BUDGET IS TWO-SIDED, and the number is not a taste. A cold gateway has no
// catalog yet and fetches one from the provider while the request is open:
// measured against the live service that first answer takes about three
// seconds, and the second one is instant. A short timeout therefore fails
// exactly once per daemon start — on the call the selector makes, so the route
// appears with no models and the operator sees a plugin that "does not work"
// while everything behind it is healthy. A budget with no limit at all is the
// other failure: a harness boot that never finishes.
const CATALOG_TIMEOUT_MS = 15000

// SELF_AGENT — who this plugin is, taken from its own package metadata.
//
// The version is read from package.json instead of being written into the
// source: a number copied by hand is wrong from the first release onwards.
const SELF_AGENT = (() => {
  try {
    const pkg = require('../package.json')
    if (pkg && typeof pkg.name === 'string' && typeof pkg.version === 'string') {
      return `${pkg.name}/${pkg.version}`
    }
  } catch {
    // A missing package.json is not worth failing over: the name alone still
    // identifies the caller.
  }
  return 'free-ai-router-dshplugin'
})()

// attributionHeaders — the headers that name the caller of the request.
//
// The harness package is the authority here: its attributionHeaders() renders
// the harness identity, and a copy of that string would silently drift from the
// harness on its next release. The package is declared as a peer dependency; it
// is resolvable in installations that expose the harness packages on the module
// path and absent in installations that keep them inside the harness bundle,
// which is what a profile tree looks like. So the import is attempted and its
// absence is an ordinary outcome, not an error.
//
// The fallback is not an invented identity either: the request to the gateway
// really is made by this plugin, and the plugin's own name and version describe
// the caller truthfully. Attribution is never suppressed — exactly one of the
// two paths always yields a user-agent.
function attributionHeaders() {
  try {
    const mod = require('@deepseek-ai/dsh-llm')
    if (mod && typeof mod.attributionHeaders === 'function') {
      const rendered = mod.attributionHeaders()
      if (rendered && typeof rendered === 'object') return rendered
    }
  } catch {
    // The harness package is not reachable from this tree: use the plugin's
    // own identity below.
  }
  return { 'user-agent': SELF_AGENT }
}

// headers assembles the request headers for the gateway.
//
// The token is sent when reading the catalog too: without it the gateway in
// server mode answers with a refusal, and a remote deployment ends up
// "connectable but not working".
function headers(json) {
  const out = {}
  if (json) out['content-type'] = 'application/json'
  if (TOKEN) out.authorization = `Bearer ${TOKEN}`
  Object.assign(out, attributionHeaders())
  return out
}

// The catalog cache: "provider/model" → the metadata the gateway reported.
//
// The cache exists because one HTTP answer describes every model at once and
// three different callers need it: the route list, the model selector, and the
// per-call metadata lookup. Without the cache each of them would fetch the same
// document, and the metadata lookup runs on every request.
const catalog = new Map()

// rememberCatalog stores one catalog answer and groups the identifiers by
// provider.
//
// The model identifier is composite: "provider/model". The split happens at the
// FIRST slash, because model identifiers themselves contain slashes (for
// example "poolside/laguna-s-2.1:free").
function rememberCatalog(body) {
  const data = Array.isArray(body?.data) ? body.data : []
  const byProvider = new Map()
  for (const item of data) {
    if (!item || typeof item.id !== 'string') continue
    const slash = item.id.indexOf('/')
    if (slash <= 0) continue

    const provider = item.id.slice(0, slash)
    const model = item.id.slice(slash + 1)
    catalog.set(item.id, { ...item, provider, model })

    if (!byProvider.has(provider)) byProvider.set(provider, [])
    byProvider.get(provider).push(model)
  }
  return byProvider
}

// modelMeta returns the gateway's metadata for one model.
//
// An empty object means the model is not in the cache yet — before the first
// successful catalog read, or for a model the gateway only just announced. The
// caller treats that as "nothing was declared", never as "declared as zero".
function modelMeta(provider, model) {
  return catalog.get(`${provider}/${model}`) || {}
}

// listProviders asks the gateway for the model catalog and refreshes the cache.
//
// Returns a "provider → models" map. An empty map means the gateway is
// unreachable: that is NOT a startup error but a normal state when the daemon
// is not up yet.
async function listProviders() {
  const response = await fetch(`${BASE}/v1/models`, {
    headers: headers(false),
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`GET /v1/models → HTTP ${response.status}`)

  return rememberCatalog(await response.json())
}

// ping checks whether the gateway is reachable.
async function ping() {
  try {
    const response = await fetch(`${BASE}/_control/status`, {
      headers: headers(false),
      signal: AbortSignal.timeout(1500),
    })
    return response.ok
  } catch {
    return false
  }
}

module.exports = {
  BASE,
  TOKEN,
  CATALOG_TIMEOUT_MS,
  SELF_AGENT,
  attributionHeaders,
  headers,
  listProviders,
  modelMeta,
  ping,
  rememberCatalog,
}
