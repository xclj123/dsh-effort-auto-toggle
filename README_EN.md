# dsh-effort-auto-toggle

A reasoning-effort scheduler for the DeepSeek Harness (DSH) desktop app: an
**Auto** button next to the model selector in the composer. Lit — the plugin
picks `reasoning_effort` for every request based on message complexity; dim —
native manual picking, and the effort dropdown in the model picker stays
untouched (no fake entries injected).

![screenshot](docs/screenshot.jpg)

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
  retries the scorer. **A scorer failure is now negatively cached for 60 s**
  (0.3.4): during the cooldown the heuristic verdict applies immediately instead
  of paying a full timeout on every step, and the scorer is retried once the
  cooldown expires. The scorer's verdict is authoritative; the heuristic
  only overrides it on an explicit heavy-keyword pile-up (score >= 70) against
  a low verdict (0.3.3).
- **Graded tool-load escalation** (session-scoped): tool calls inside the last
  10 minutes buy rungs by argument size — >= 800 characters buys one rung,
  >= 3200 buys two, saturating at the heaviest rung (0.3.4). The old code had a
  dead zone: anything between 800 and 3199 characters changed nothing, so a
  3000-character `apply_patch` was treated exactly like a bare `ls`. A bare `ls`
  still never lifts the session (0.3.3), a mid-size patch buys one rung, a big
  one buys two. A hand-picked effort is never escalated.
- **Manual wins**: a hand-picked effort always passes through untouched,
  including adapter-specific names like `ultra`.
- **GLM-5.3 safe**: a manual `off` on forced-thinking models is clamped to
  the ladder's lightest rung instead of an API error.
- **Live labels**: the lit button shows the real effort id (`Auto·low`,
  `Auto·highx`), per-reply badges mirror it, in the adapter's own English
  naming.
- **Ledger**: every decision plus observed token usage lands in JSONL under
  `~/.dsh/effort-auto-toggle/`, with a markdown report. Decisions are written as
  separate `plan` rows first (0.4.0), so a restart, a restored session or a
  different process picking up the file can still explain why a step ran at the
  effort it did.
- **Manual vs echo** (0.4.0): the host feeds the plugin's own last write back
  into the next request, so a baseline diff separates "the user picked this"
  from "this is our own echo" — a hand pick is honoured immediately, an echo is
  never mistaken for one.
- **Decision chip** (0.4.0): the button tooltip gains a `last decision` line,
  e.g. `low · minimax 12 → low` (semantic tier · scorer source score → wire
  effort). It rides the same settings write as the savings line, so the hot
  path pays nothing extra.
- **`/effort` command** (0.4.0): `/effort` (= status) shows the switch, the
  model, the ladder, the current wire effort, the last decision and the savings
  line; `/effort on|off` flips scheduling; `/effort low|high|max` pins a rung.
- **Cost estimate** (0.4.0): the report prices every step against a built-in
  catalog (deepseek / glm / minimax / kimi / qwen / doubao, including DeepSeek's
  peak/off-peak schedule). A model outside the catalog is reported as
  "unpriced" rather than guessed; `<ledger dir>/prices.json` adds your own
  rates.

## Requirements

- DeepSeek Harness desktop 0.2.1 through **0.2.2-rc.3** (anchor list under
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

> On first arming with no scorer key configured, a popover above the composer toggle lets the user paste a key (saved straight into plugin settings), switch to the keyless heuristic mode, or dismiss.

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
5. `/effort` in the composer shows the state and can flip the switch or pin a
   rung (`/effort on` / `off` / `low` / `high` / `max`).

## Ledger & report

```bash
node lib/report.js <sessionId-prefix>   # per-session scheduling/token report
```

The report prints two tables: **actual effort** (bucketed dynamically by the
effort that really ran — a single-level model shows only `high`, a five-level
one adds `highx`/`ultra`, lightest first) and **classifier verdict** (bucketed
by semantic tier). They disagree on purpose: a semantic `low` on a one-level
model necessarily executes as `high`.

The report also folds replayed duplicate rows (and says how many), estimates
downshift savings against an always-heaviest counterfactual, and prices the run
with the built-in catalog (`估算费用：¥51.88（另有 6225 步未计价…）`).

Add rates with `<ledger dir>/prices.json`, keyed by `provider`, `model` or
`provider|model`, value `{"inputMiss": 4, "cacheRead": 0.8, "output": 18}`
(per million tokens, CNY).

Decision rows and usage rows are separate: `{"kind":"plan",…}` records why that
effort was chosen, the usage row records what the step actually cost;
`lib/report.js` counts usage rows only.

## Uninstall

```bash
node tools/install.mjs --profile "<profile dir>" --remove
```

Restores `package.json` / `cordis.patch.yml` and removes the plugin files;
restart DSH.

## Tests

```bash
npm test              # 77 cases, zero-dependency (node --test), no npm install
node tools/check.mjs  # self-check: d.ts vs exports, packed files, readEvents probe
```

Covers: passthrough sanitisation, manual wins, full armed scheduling on a
5-rung model, graded tool-load escalation, scorer backoff, capability guards
(a model with no dial is never scheduled), ledger plan rows and cross-process
attribution, the baseline diff (echo vs hand pick), the `/effort` command,
price matching and cost estimates, report de-duplication, button tier labels
(incl. degradation without a sessions service).

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

Host anchor points (verified against the DSH 0.2.2-rc.3 **and** 0.2.2-rc.5 asar; the two agree):

**DSH 0.2.1 through 0.2.2-rc.5**: the plugin
probes the host at runtime — legacy hosts keep the `agent/request` rewrite path,
modern hosts (where effort rides `agent.model.select()` and `agent/request` is
validated read-only) switch to the claim-time decision path automatically.

- `agent/inbox/claimed` broadcast (the claim-time decision window on 0.2.2+ hosts) and the `agent.model.select()` API
- `session/event` (**the ledger's primary write path**: a usage row is written as
  soon as the host reports it, no longer requiring `agent/request` — 0.3.4)
- `agent/request` waterfall (registered with prepend; read-only on 0.2.2+ hosts,
  kept only as a catch-up sweep — upstream marks it `@deprecated`, "do not add
  new listeners")
- `llm` service `resolveModelInfo(provider, model)` — the 0.2.0 ladder source. Info with
  **no `reasoning` block** means "this route has no dial": 0.3.5+ remembers an empty ladder
  and never schedules against it (before 0.3.5 it pretended the default three levels and
  earned `UNSUPPORTED_REASONING_EFFORT` from the adapter). `INVALID_MODEL_REASONING` is
  treated the same way; transport/unknown-model errors are not cached and retried
- `settings` service modern `describe` / `update` (ns = profile entry id). The hot path
  no longer calls `describe()`: the volatile fields handed over at assembly are live
  `{get()}` refs, so 0.3.5+ reads them directly instead of re-enumerating the form on
  every request
- `Session` event reads: 0.2.2-rc.3 dropped `Session.events`, so 0.3.3+ probes
  `snapshotEvents()` → `ownEvents()` → `eventAt()`/`seq` → `events`
- client side: `conversation.input.right` slot, `modelSelection` session
  projection, `configForms`, `sessions` service (captured via nested
  `ctx.inject`)
- client package list: `dsh-client-ui-renderer` / `dsh-client-locale` /
  `dsh-client-ui-settings` / `dsh-api-remotes`
- `commands` service (the `/effort` command, 0.4.0): registered through
  `ctx.inject(['commands'])`; a host without the service simply never sees the
  command, everything else keeps working

**Deliberately not used**: `appendPluginRecord` (in-session plugin records) and
`sessionProjections` registration. The former lives in
`@deepseek-ai/dsh-session`, which is not a profile dependency, so a local plugin
cannot resolve it; the latter requires `stateSchema` to be a real zod schema
(the framework calls `.parse()`, schemastery has none). 0.4.0 reaches the same
"the decision is attributable" goal with a plan row in the ledger — one line of
JSONL, no new dependency.

If a host update moves these anchors the plugin needs to follow; issues
welcome.

## License

MIT
