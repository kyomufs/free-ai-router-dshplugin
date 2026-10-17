'use strict'

// free-ai-router-plugin — access to free AI providers through the local
// free-ai-router gateway.
//
// WHAT CHANGED COMPARED TO THE PREVIOUS PLUGIN. Before, the plugin knew a
// single provider and registered a single route. Now it asks the daemon for the
// list and registers EVERY provider as a separate route: all of them appear in
// the model selector, and switching between them requires no code changes.
//
// WHAT THE PLUGIN DOES NOT DO. It does not spoof the request shape, does not
// store keys, and does not decide which transport to use. All of that is the
// daemon's work. The plugin translates a harness call into a request to the
// gateway and translates the response back. That separation means a new
// provider appears without releasing the plugin: a section in the daemon
// configuration is enough.

const { listProviders, ping, BASE, headers } = require('./daemon.cjs')
const { createAdapter } = require('./adapter.cjs')

const name = 'free-ai-router-plugin'
const inject = ['llm']

// DEFAULT_PROVIDER — the route available before the gateway has answered.
//
// The plugin must register at least something at startup: the daemon may not be
// up yet, and a route in the selector is needed immediately. This route keeps
// working afterwards too — as an ordinary one.
const DEFAULT_PROVIDER = 'opencode'

// apply registers routes and starts the background list refresh.
function apply(ctx, config = {}) {
  const registered = new Set()

  const register = (provider) => {
    if (registered.has(provider)) return
    registered.add(provider)
    ctx.llm.registerAdapter([provider], createAdapter(ctx, provider))
  }

  // The first route is registered immediately, without waiting for the gateway:
  // otherwise, with the daemon unreachable, the model selector would be empty
  // and the operator would not understand what exactly is wrong.
  register(DEFAULT_PROVIDER)

  // The rest are pulled from the gateway. This is a background task: its
  // failure must not interfere with harness startup.
  refresh(ctx, register).catch((error) => {
    ctx.logger.warn(
      '%s: failed to fetch the provider list from %s (%s); only %s registered',
      name, BASE, String(error?.message ?? error), DEFAULT_PROVIDER,
    )
  })

  // If the gateway appears later, the list refreshes by itself: there is no
  // need to hold up the harness over startup ordering.
  ctx.effect(() => {
    const timer = setInterval(() => {
      refresh(ctx, register).catch(() => {})
    }, 30000)
    return () => clearInterval(timer)
  }, 'free-ai-router-plugin:refresh')
}

// refresh asks for the catalog and registers the providers found.
async function refresh(ctx, register) {
  const byProvider = await listProviders()
  for (const provider of byProvider.keys()) {
    register(provider)
  }
  ctx.logger.info('%s: providers available — %d (%s)',
    name, byProvider.size, [...byProvider.keys()].join(', ') || 'none')
}

module.exports = { apply, inject, name, DEFAULT_PROVIDER, ping, headers, BASE }
