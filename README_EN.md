# dsh-effort-auto-toggle

A reasoning-effort scheduler for the DeepSeek Harness (DSH) desktop app: an
**Auto** button next to the model selector in the composer. Lit — the plugin
picks `reasoning_effort` for every request based on message complexity; dim —
native manual picking, and the effort dropdown in the model picker stays
untouched (no fake entries injected).

Forked from `dsh-adaptive-effort`, which injected an "auto" entry into the
effort dropdown; switching models or a stale snapshot could forward it to the
provider and trigger `UNSUPPORTED_REASONING_EFFORT`. This fork moves "auto"
onto a standalone button and sanitises every non-real effort on the
passthrough path, killing that class of errors at the root.

## Features

- **Toggle button**: lit = auto scheduling; dim = native manual picking, and
  turning it off restores the effort you had selected before going auto.
- **Model-adaptive ladders** (0.2.0+): no hard-coded low/high/max. Each
  request asks the host `llm` service for the model's real effort list
  (glm-5.3 is low/high/max; other adapters may be low/high/highx/max/ultra)
  and maps the scheduler's three semantic tiers onto it: light -> lightest,
  heavy -> heaviest, mid -> about the 2/3 position.
- **Complexity scoring**: a small model on any OpenAI-compatible endpoint
  (thinking disabled on the scorer call — fast and cheap); zero-dependency
  heuristic fallback (keywords + length + code fences) when the key, network
  or timeout fails. Fallback results are NOT cached — the next message
  retries the scorer.
- **Tool-continuity upgrade** (session-scoped): a low-tier pick upgrades when
  heavy tool calls appear within 10 minutes in the SAME session, so long
  tool chains don't break on the lightest rung.
- **Manual wins**: a hand-picked effort always passes through untouched,
  including adapter-specific names like `ultra`.
- **GLM-5.3 safe**: a manual `off` on forced-thinking models is clamped to
  the ladder's lightest rung instead of an API error.
- **Live labels**: the lit button shows the real effort id (`Auto·low`,
  `Auto·highx`), per-reply badges mirror it, in the adapter's own English
  naming.
- **Ledger**: every decision plus observed token usage lands in JSONL under
  `~/.dsh/effort-auto-toggle/`, with a markdown report.

## Requirements

- DeepSeek Harness desktop (verified on the 2026-10 host; anchor list under
  "Compatibility")
- Node.js >= 20 (for the installer and tests; the DSH-bundled node works)

A scorer model is OPTIONAL: install with `--mode heuristic` and it runs on
the pure heuristic — less accurate than a small scoring model, zero setup.

## Install

```bash
git clone <repo-url>
cd dsh-effort-auto-toggle

# list the profiles on this machine (auto-discovers ~/.dsh/profiles/)
node tools/install.mjs

# install into a TEST profile first (recommended)
node tools/install.mjs --profile "<profile dir>"

# with a scorer endpoint (any OpenAI-compatible chat API)
node tools/install.mjs --profile "<profile dir>"   --mode minimax --minimax-key <your-key>   --minimax-url https://open.bigmodel.cn/api/coding/paas/v4   --minimax-model glm-5.3-flash

# the live "desktop" profile requires an explicit --force
node tools/install.mjs --profile "<...>/profiles/desktop" --force <same options>
```

**Restart DSH** after installing. The installer is idempotent, backs up every
file it rewrites (`.bak-<timestamp>`), and supports `--dry-run`.
Cross-platform: profiles are auto-discovered under `~/.dsh/profiles/` via
`os.homedir()` + `path.join` (Windows / macOS / Linux).

## Configuration

Written into the profile's `cordis.patch.yml` at install time; afterwards
editable on the settings card (no restart needed):

| field | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `autoOn` | `false` | current button state (lit = true) |
| `mode` | `minimax` | `minimax` (LLM scorer) / `heuristic` |
| `minimaxApiKey` | — | scorer endpoint key |
| `minimaxBaseUrl` | — | OpenAI-compatible chat base URL |
| `minimaxModel` | — | scorer model (pick something cheap and fast) |
| `allowToolUpgrade` | `true` | continuity upgrade switch |

YAML-only fields: `scoreTimeoutMs` (default 9000ms), `clampForcedThinkingOff`
(default true), `ledgerDir` (default `~/.dsh/effort-auto-toggle`).

## Usage

1. After restarting DSH, an Auto button appears left of the model selector
   (dim).
2. Click it — from the next message on, efforts are scheduled; the button
   label tracks the actually-used effort (`Auto·low` -> `Auto·high` -> ...).
3. Click again to dim — your pre-auto manual pick is restored, everything
   behaves natively.
4. Each reply carries a badge with the effort actually used.

## Ledger & report

```bash
node lib/report.js <sessionId-prefix>   # per-session scheduling/token report
```

## Uninstall

```bash
node tools/install.mjs --profile "<profile dir>" --remove
```

Restores `package.json` / `cordis.patch.yml` and removes the plugin files;
restart DSH.

## Tests

```bash
npm test   # 21 cases, zero-dependency (node --test), no npm install needed
```

Covers: passthrough sanitisation, manual wins, full armed scheduling on a
5-rung model, continuity upgrades, session isolation, ladder pure functions,
button tier labels (incl. degradation without a sessions service).

## Differences vs dsh-adaptive-effort

| | adaptive-effort (upstream) | this fork |
|---|---|---|
| auto entry | "auto" injected into the dropdown | standalone button, dropdown untouched |
| `auto` leakage | possible (API error) | sanitised on every passthrough |
| ladder | hard-coded low/high/max | model-adaptive (0.2.0+) |
| labels | localized | adapter-native English ids |
| fallback caching | fallback cached, sticks for the turn | not cached, retried next message |
| continuity | leaks across sessions | session-scoped (0.1.5+) |
| host settings API | legacy `register()` (silently dead on new hosts) | modern describe/update (0.1.2+) |

## Compatibility

Host anchor points (verified against the 2026-10 desktop asar):

- `agent/request` waterfall (registered with prepend)
- `session/event` (usage backfill into the ledger)
- `llm` service `resolveModelInfo(provider, model)` — the 0.2.0 ladder source
- `settings` service modern `describe` / `update` (ns = profile entry id)
- client side: `conversation.input.right` slot, `modelSelection` session
  projection, `configForms`, `sessions` service (captured via nested
  `ctx.inject`)

If a host update moves these anchors the plugin needs to follow; issues
welcome.

## License

MIT
