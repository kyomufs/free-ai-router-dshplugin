# free-ai-router-dshplugin

Free models from several providers inside DeepSeek Harness, through the local
[free-ai-router](https://github.com/kyomufs/free-ai-router) gateway.

Every provider the gateway serves appears in the model selector as its **own
route**. Adding a provider needs no plugin release: a section in the gateway
configuration is enough.

## Install

```sh
dsh plugin --profile web add github:kyomufs/free-ai-router-dshplugin
```

Restart `dsh web` — the routes appear in the model picker.

## How it works

```
harness (DSH) ──▶ free-ai-router-dshplugin ──▶ free-ai-router ──▶ provider
                        │                           │
                  call translation            request shape,
                  and stream parsing          keys, transport
```

On startup the plugin asks the gateway for the list of providers and registers
each one as a separate route. If the gateway is not up yet, the default route is
registered and the rest arrive later — no harness restart is needed for startup
ordering.

## What the plugin does not do

This is the boundary, and it is deliberate:

- **it does not reshape the request** — the gateway does that, and the shape
  differs per provider;
- **it does not keep keys** — the keys live in the gateway; the plugin has none;
- **it does not choose the egress path** — the transport belongs to the gateway
  too;
- **it does not retry** — the harness owns the retry policy, and a second policy
  on top of it would break the harness's own arithmetic.

Refusals are passed through **verbatim**: status, body and headers reach the
harness unchanged, so the harness applies its logic to the same answer it would
have seen talking to the provider directly.

## Model capabilities

The plugin never invents a limit. Context window, output ceiling, input
modalities and the reasoning ladder are read from the gateway's `/v1/models`
answer, which is the only party that knows them, and a capability the gateway
did not declare is **omitted rather than filled in**: the harness validates
these fields strictly, so a substitute number is either a rejection or a lie
about a limit nobody knows.

## Images

A photo attached in the harness reaches the model as an `image_url` part with a
`data:` URL — the only form the gateway accepts, since it never fetches an
address on the client's behalf. The bytes are read from the harness attachment
service through the durable reference the message carries, once per attachment,
and scaled into the route's image budget (4 Mpx, 1 MiB) without enlarging them.

An image the harness marked `offloaded` is **not** re-sent: that flag is the
harness's own decision to keep it out of the request, made when a previous
attempt hit an image budget. The model sees a note in its place instead, so it
reports an omission rather than answering about an image it never received.

A route whose harness has no attachment service fails the call with
`UNSUPPORTED_CONTENT` instead of quietly sending a text-only request.

## Retry shape

The policy handed to the harness is returned **already resolved**, with the
delays on the top level next to the mode. The retry scheduler reads them from
there and does not unwrap a nested backoff; a descriptive form reaches it as "no
delays" and the delay is computed from NaN.

A wait the provider asked for travels under the name the scheduler reads,
`providerRetryAfterMs`, and is omitted entirely when the provider asked for no
wait: the harness rejects a present-but-unusable value, zero included.

## Attribution

Every request carries a `user-agent`. The value comes from the harness package
when it is resolvable, and from the plugin's own name and version otherwise —
never from a string copied into the source, which would drift on the next
release.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `FREE_AI_ROUTER_BASE` | gateway address, no path | `http://127.0.0.1:8787` |
| `FREE_AI_ROUTER_TOKEN` | token for `server` mode | empty |

`FREE_AI_ROUTER_TOKEN` is a **different** secret from a provider key: a key opens
access to the service, the token opens access to your gateway. An empty value is
normal for `local` mode — nobody but this machine can reach a loopback listener.

## Tests

```sh
npm test
```

The plugin's boundaries are checked: how it reads the gateway catalog, how it
translates messages, how it parses the stream, and how a refusal crosses the
wire. No network is used — the gateway is replaced by a stub.

## License

MIT
