'use strict'

// Communication with the free-ai-router daemon.
//
// Everything the plugin knows about the gateway is collected here: the address,
// the token, the list of providers and models. The rest of the plugin's code
// works with already resolved values and knows nothing about the transport.

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
const CATALOG_TIMEOUT_MS = 2000

// headers assembles the request headers for the gateway.
//
// The token is sent when reading the catalog too: without it the gateway in
// server mode answers with a refusal, and a remote deployment ends up
// "connectable but not working".
function headers(json) {
  const out = {}
  if (json) out['content-type'] = 'application/json'
  if (TOKEN) out.authorization = `Bearer ${TOKEN}`
  return out
}

// listProviders asks the gateway for the model catalog.
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

  const body = await response.json()
  const data = Array.isArray(body?.data) ? body.data : []

  // The model identifier is composite: "provider/model". The split happens at
  // the FIRST slash, because model identifiers themselves contain slashes
  // (for example "poolside/laguna-s-2.1:free").
  const byProvider = new Map()
  for (const item of data) {
    if (!item || typeof item.id !== 'string') continue
    const slash = item.id.indexOf('/')
    if (slash <= 0) continue

    const provider = item.id.slice(0, slash)
    const model = item.id.slice(slash + 1)
    if (!byProvider.has(provider)) byProvider.set(provider, [])
    byProvider.get(provider).push(model)
  }
  return byProvider
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

module.exports = { BASE, TOKEN, headers, listProviders, ping }
