# AGENTS.md — free-ai-router-dshplugin

Rules for working in this repository.

## Build, commit and push — the agent does it itself

**This is the main rule of the repository.** No reminders are needed: after every
finished change the agent runs the cycle and publishes the result on its own.

### The full cycle

```sh
# 1. Syntax of every module
for f in lib/*.cjs lib/*.js test/*.cjs; do node --check "$f" || echo "FAIL $f"; done

# 2. Checks
node test/smoke.cjs

# 3. Publication
git add -A
git status --short
git diff --cached --stat
```

Commit and push:

```sh
git -c user.name="kyomufs" -c user.email="kyomufsdev@gmail.com" commit -F - <<'EOF'
<type>: <what changed and why>

<body: the reason, not a retelling of the diff>
EOF

TOKEN=$(grep -o 'ghp_[A-Za-z0-9]*' /home/kyomufs/.dsh/profiles/web/cordis.patch.yml | head -1)
git push "https://kyomufs:$TOKEN@github.com/kyomufs/free-ai-router-dshplugin.git" HEAD:main \
  2>&1 | sed 's/ghp_[A-Za-z0-9]*/***/g'
```

### Secrets

**Before every commit:**

```sh
grep -rn "ghp_\|sk-[A-Za-z0-9]" --include="*.cjs" --include="*.js" --include="*.json" . \
  | grep -v node_modules | head
```

Empty is good. The push token is read from `cordis.patch.yml` and **never** lands
in a file. It is always masked in the output.

### What not to commit

`node_modules/` — it is in `.gitignore`.

## Structure

Modules are split **by question**, not by convenience:

| Module | The question it answers |
|---|---|
| `daemon.cjs` | what the plugin knows about the gateway: address, token, catalog |
| `adapter.cjs` | how a provider is presented to the harness |
| `stream.cjs` | how a call turns into a request and back |
| `sse.cjs` | how stream frames turn into events (no network) |

New code goes into the module whose question it answers. A file answering two
questions at once is a signal that the boundary was drawn wrong.

## Boundary of responsibility

**The plugin is a mediator, not a second gateway.** It translates the call and
the stream, and nothing more. The check is easy: if the code does something from
the list below, it is written in the wrong place.

The plugin does **not**:

- reshape the request — the shape belongs to each provider, and the gateway
  knows it;
- keep keys — they live in the gateway; the plugin has none;
- choose the transport;
- retry — the harness owns the retry policy, and a second policy on top of it
  would break the harness's own arithmetic;
- parse the body of a refusal — it passes it through **verbatim**, because the
  harness looks in it for the signals it decides by;
- invent a model capability — the cache holds what the gateway reported, and an
  undeclared capability is omitted, never defaulted.

Duplicating any of these decisions would mean two places where the same thing is
done differently.

## Tests

The plugin's **boundaries** are checked, not the gateway's work: reading the
model catalog, translating messages, parsing the stream, and the shape of a
refusal on the wire. No network is used — the gateway is replaced by a stub.

Where a check asserts a shape (for example the split of a composite identifier),
it does so **on its own** instead of calling the implementation: a check has to
notice a change in the implementation, not echo it.

## Comments

In English, like the rest of the text in the code. They explain **why**, not
what.
