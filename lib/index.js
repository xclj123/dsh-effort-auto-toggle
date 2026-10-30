import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import z from '@deepseek-ai/schemastery';
import { clampForModel, isWireEffort } from "./effort.js";
import { assertAutoTier } from "./effort.js";
import { buildLadder, DEFAULT_LADDER, guessSemantic, isPickableEffort, semanticToLadder, assertScheduledEffort } from "./effort.js";
import { heuristicClassify, minimaxClassify } from "./classifier.js";
import { scheduleEffort, TurnScoreCache } from "./scheduler.js";
import { defaultLedgerDir, Ledger } from "./ledger.js";
import { latestUserMessage, messageText, recentToolCalls, sessionIdOf, usageSince, } from "./session-events.js";

/**
 * dsh-effort-auto-toggle — fork of dsh-adaptive-effort with a different entry
 * point: NO 自动 option is injected into the model popup. Auto scheduling is
 * armed by a client-side toggle button (settings key `autoOn`, flipped by the
 * button next to the model selector). Toggle ON → auto tier per message;
 * toggle OFF → the native manual picker rules again (passthrough).
 */

/** Composition-entry schema (cordis.yml `config:` of the plugin row). */
export const Config = z.object({
    // volatile: editable from the settings form (host SettingsForms only
    // accepts writes to volatile paths; ns = profile entry id).
    enabled: z.boolean().default(true).volatile().description('Master switch'),
    autoOn: z.boolean().default(false).volatile().description('Auto scheduling armed'),
    mode: z.union(['minimax', 'heuristic']).default('minimax').volatile().description('Classifier backend'),
    minimaxApiKey: z.string().default('').volatile().description('Classifier API key'),
    minimaxBaseUrl: z.string().default('https://api.minimaxi.com/v1').volatile().description('Classifier endpoint'),
    minimaxModel: z.string().default('MiniMax-M3').volatile().description('Classifier model'),
    scoreTimeoutMs: z.number().default(9000),
    allowToolUpgrade: z.boolean().default(true).volatile().description('Allow tier upgrade for heavy tool calls'),
    clampForcedThinkingOff: z.boolean().default(true),
    ledgerDir: z.string().default(''),
});

/** Settings defaults, kept in lockstep with the schema. */
export const DEFAULT_CONFIG = {
    enabled: true,
    autoOn: false,
    mode: 'minimax',
    minimaxApiKey: '',
    minimaxBaseUrl: 'https://api.minimaxi.com/v1',
    minimaxModel: 'MiniMax-M3',
    scoreTimeoutMs: 9000,
    allowToolUpgrade: true,
    clampForcedThinkingOff: true,
    ledgerDir: '',
};

/** Locale/legacy namespace id (the client bundle registers dictionaries under it). */
export const SETTINGS_NAMESPACE = 'effort-auto-toggle';

/** Package id: the 0.2.x settings service keys forms by profile entry id. */
const PKG_NS = 'dsh-effort-auto-toggle';

// 0.2.0 model-adaptive ladders: the host `llm` service (dsh-llm) exposes
// resolveModelInfo(provider, model) -> { reasoning: { efforts: [{id}, ...] } },
// i.e. the EXACT effort levels of the target model. We keep one resolved
// ladder per provider|model (capabilities are stable for a process life).
let llmRef = null;
const ladderCache = new Map();
async function effortLadderFor(provider, model) {
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '')
        return DEFAULT_LADDER.slice();
    const key = provider + '|' + model;
    const hit = ladderCache.get(key);
    if (Array.isArray(hit))
        return hit;
    if (llmRef === null || typeof llmRef.resolveModelInfo !== 'function')
        return DEFAULT_LADDER.slice();
    try {
        const info = await llmRef.resolveModelInfo(provider, model);
        const ladder = buildLadder(info && info.reasoning && info.reasoning.efforts);
        ladderCache.set(key, ladder);
        return ladder;
    }
    catch {
        return DEFAULT_LADDER.slice(); // not cached: retried on the next request
    }
}

/** Unwrap a schemastery volatile container ({ get() }) to its plain value. */
function plainValue(v) {
    if (v !== null && typeof v === 'object' && typeof v.get === 'function' && Object.keys(v).length <= 1) {
        try { return plainValue(v.get()); } catch { return undefined; }
    }
    return v;
}

/** Resolve the composition config with volatile containers unwrapped. */
function resolvePlainConfig(config) {
    const out = {};
    for (const [k, v] of Object.entries(config ?? {})) {
        const pv = plainValue(v);
        out[k] = pv === undefined ? (DEFAULT_CONFIG[k] ?? pv) : pv;
    }
    return out;
}

/**
 * 0.2.x host: the settings service exposes describe()/update() keyed by
 * profile entry id (there is no register()). Bind lazily — the service may
 * become available after apply().
 */
function bindSettingsForms(ctx) {
    let forms = null;
    try {
        ctx.inject(['llm'], (lctx) => {
            const svc = lctx && lctx.llm;
            if (svc && typeof svc.resolveModelInfo === 'function')
                llmRef = svc;
        });
    }
    catch { /* no llm service: DEFAULT_LADDER semantics apply */ }
    ctx.inject(['settings'], (sctx) => {
        const svc = sctx && sctx.settings;
        if (svc && typeof svc.describe === 'function' && typeof svc.update === 'function') forms = svc;
    });
    return () => forms;
}

/** The settings namespace actually served for this plugin (entry id first, package name fallback). */
function settingsEntryNs(ctx, rows) {
    const candidates = [];
    try {
        const entry = ctx && ctx.fiber ? ctx.fiber.entry : null;
        const raw = entry ? (entry.options && entry.options.id) || entry.id : null;
        if (typeof raw === 'string' && raw !== '') {
            const colon = raw.lastIndexOf(':');
            candidates.push(colon === -1 ? raw : raw.slice(colon + 1));
        }
    } catch {}
    candidates.push(PKG_NS);
    if (!Array.isArray(rows)) return candidates[candidates.length - 1];
    for (const c of candidates) if (rows.some((r) => r && r.ns === c)) return c;
    return candidates[candidates.length - 1];
}

/**
 * Live config accessor: reads the plugin's volatile form value (what the
 * settings document actually says now) over the composition defaults, so a
 * toggle flip from the client is picked up on the very next request without
 * a reload. Falls back to the composition config when the service is absent.
 */
function makeLiveCfg(ctx, getForms, baseConfig) {
    return () => {
        const forms = getForms();
        if (!forms) return baseConfig;
        try {
            const rows = forms.describe();
            if (!Array.isArray(rows)) return baseConfig;
            const ns = settingsEntryNs(ctx, rows);
            const row = rows.find((r) => r && r.ns === ns);
            if (row && row.value && typeof row.value === 'object') {
                return { ...baseConfig, ...row.value };
            }
        } catch {}
        return baseConfig;
    };
}

export function apply(ctx, config = DEFAULT_CONFIG) {
    const baseConfig = resolvePlainConfig(config);
    const getForms = bindSettingsForms(ctx);
    const liveCfg = makeLiveCfg(ctx, getForms, baseConfig);
    const scoreCache = new TurnScoreCache(64);
    const ledger = new Ledger(config.ledgerDir || defaultLedgerDir());
    overrideStateDir = config.ledgerDir || defaultLedgerDir();
    const pending = new Map();
    const scannedIndex = new Map();
    const on = ctx.on;
    // host 0.2.1-rc.3: agent/request payload only carries {turn,step,signal};
    // read the last claimed user message and usage from broadcast events.
    let lastClaimedText = null;
    let lastClaimedTurn = -1;
    const recentUsage = [];
    const recentToolCallsCache = [];
    // The host echoes our injected effort back as the next seed.reasoningEffort.
    // Track our own overrides (persisted) plus genuine manual picks so an echo
    // is never mistaken for a manual selection. Also remembers the manual effort
    // that was live BEFORE auto was armed, to restore it right after disarming.
    let lastOverride = loadOverrideState();
    let manualPick = { sessionId: null, effort: undefined };
    on("agent/inbox/claimed", (rec) => {
        try {
            const t = messageText(rec && rec.message);
            if (typeof t === "string" && t.trim().length > 0) {
                lastClaimedText = t;
                lastClaimedTurn = typeof rec.turn === "number" ? rec.turn : -1;
            }
        } catch {}
    });
    on("session/event", (session, event) => {
        try {
            if (event && event.type === "tool/call" && event.data && typeof event.data.name === "string") {
                const a = event.data.arguments;
                const argsSize = typeof a === "string" ? a.length : (()=>{try{return JSON.stringify(a).length}catch{return 0}})();
                recentToolCallsCache.push({ name: event.data.name, argsSize, sessionId: sessionIdOfEvent(session), at: Date.now() });
                if (recentToolCallsCache.length > 32) recentToolCallsCache.shift();
            }
            if (!event || event.type !== "assistant/message" || !event.data) return;
            const usage = event.data.usage;
            if (!usage || typeof usage.inputTokens !== "number" || typeof usage.outputTokens !== "number") return;
            const source = event.data.message && event.data.message.source ? event.data.message.source : {};
            recentUsage.push({
                sessionId: sessionIdOfEvent(session),
                turn: typeof event.data.turn === "number" ? event.data.turn : 0,
                step: typeof event.data.step === "number" ? event.data.step : 0,
                provider: typeof source.provider === "string" ? source.provider : "unknown",
                model: typeof source.model === "string" ? source.model : "unknown",
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
            });
            if (recentUsage.length > 256) recentUsage.shift();
        } catch {}
    });
    on('agent/request', async (payload, next) => {
        const seed = await next();
        const cfg = liveCfg();
        if (!cfg.enabled)
            return seed;
        const agent = payload.agent;
        const events = readEvents(agent);
        const sessionId = sessionIdOf(agent);
        const provider = typeof seed.provider === 'string' ? seed.provider : '';
        const model = typeof seed.model === 'string' ? seed.model : '';
        const ladder = await effortLadderFor(provider, model);
        // 1) Ledger ingestion: scan usage records appended since the last visit.
        const lastIndex = scannedIndex.get(sessionId) ?? -1;
        for (const usage of usageSince(events, lastIndex)) {
            const key = `${usage.turn}:${usage.step}`;
            const decision = pending.get(key);
            const record = {
                ts: new Date().toISOString(),
                sessionId,
                turn: usage.turn,
                step: usage.step,
                model: usage.model,
                provider: usage.provider,
                tier: decision?.tier ?? guessSemantic(seed.reasoningEffort, ladder),
                effort: decision?.effort ?? (typeof seed.reasoningEffort === 'string' && seed.reasoningEffort !== '' ? seed.reasoningEffort : semanticToLadder('high', ladder)),
                reason: decision?.reason ?? '无记录（插件中途启用或会话恢复）',
                classifierSource: decision?.classifierSource ?? 'unknown',
                classifierScore: decision?.classifierScore ?? 0,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
            };
            pending.delete(key);
            void ledger.append(record);
        }
        if (events.length === 0 && recentUsage.length > 0) {
            for (const usage of recentUsage.filter((u) => u.sessionId === null || u.sessionId === sessionId)) {
                const key = usage.turn + ":" + usage.step;
                const decision = pending.get(key);
                const record = {
                    ts: new Date().toISOString(),
                    sessionId,
                    turn: usage.turn,
                    step: usage.step,
                    model: usage.model,
                    provider: usage.provider,
                    tier: decision ? decision.tier : guessSemantic(seed.reasoningEffort, ladder),
                    effort: decision ? decision.effort : (typeof seed.reasoningEffort === "string" && seed.reasoningEffort !== "" ? seed.reasoningEffort : semanticToLadder("high", ladder)),
                    reason: decision ? decision.reason : "fallback (no events on payload)",
                    classifierSource: decision ? decision.classifierSource : "unknown",
                    classifierScore: decision ? decision.classifierScore : 0,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                };
                pending.delete(key);
                void ledger.append(record);
            }
            for (let i = recentUsage.length - 1; i >= 0; i -= 1) {
                const u = recentUsage[i];
                if (u.sessionId === null || u.sessionId === sessionId) recentUsage.splice(i, 1);
            }
        }
        if (events.length > 0)
            scannedIndex.set(sessionId, events.length - 1);
        // 2) Plan. The ONLY trigger for scheduling is the toggle button being ON
        //    (settings key autoOn). While ON, the manual picker is ignored. While
        //    OFF, everything rides through untouched (native manual selection).
        const selected = seed.reasoningEffort;
        const autoActive = cfg.autoOn === true;
        const echoOfOverride = plan_echoCheck(lastOverride, manualPick, selected, sessionId);
        const plan = autoActive
            ? { mode: 'schedule' }
            : { mode: 'passthrough' };
        let tier = 'high';
        let classifierSource = 'n/a';
        let classifierScore = 0;
        if (plan.mode === 'schedule') {
            let message = latestUserMessage(events);
            if (message === undefined && lastClaimedText !== null &&
                (payload.turn === undefined || lastClaimedTurn === -1 || payload.turn === lastClaimedTurn)) {
                message = { text: lastClaimedText, index: -1 };
            }
            let result = message ? scoreCache.lookup(message.text) : undefined;
            if (result === undefined && message !== undefined) {
                result = cfg.mode === 'minimax'
                    ? await minimaxClassify(message.text, {
                        apiKey: cfg.minimaxApiKey,
                        baseUrl: cfg.minimaxBaseUrl,
                        model: cfg.minimaxModel,
                        timeoutMs: cfg.scoreTimeoutMs,
                    })
                    : heuristicClassify(message.text);
                if (result.note === undefined)
                scoreCache.remember(message.text, result);
                if (result.note !== undefined) {
                    ctx.logger?.warn?.('[effort-auto-toggle] scorer: %s', result.note);
                }
            }
            tier = result?.tier ?? 'high';
            classifierSource = result?.source ?? 'unknown';
            classifierScore = result?.score ?? 0;
        }
        let effort;
        let reason;
        if (plan.mode === 'schedule') {
            // Session-scoped continuity: only tool calls from THIS session keep a
            // low tier pinned up. A previous/other session's tool activity (the
            // cross-session contamination that kept a fresh "你好" on high) no
            // longer counts; unattributable events (sessionId null) stay inclusive.
            const sameSessionToolCalls = recentToolCallsCache.filter((c) => c.sessionId === null || c.sessionId === sessionId);
            const calls = events.length > 0 ? recentToolCalls(events) : sameSessionToolCalls.slice(-8).map((c) => ({ name: c.name, argsSize: c.argsSize }));
            const lastSameSessionToolAt = sameSessionToolCalls.reduce((max, c) => Math.max(max, c.at), 0);
            if (tier === "low" && sameSessionToolCalls.length > 0 && Date.now() - lastSameSessionToolAt < 10 * 60 * 1000 && manualPick.effort !== "low") {
                tier = lastOverride.effort === ladder[ladder.length - 1] ? "max" : "high";
                classifierSource = classifierSource === "minimax" ? "minimax+continuity" : classifierSource + "+continuity";
            }
            const decision = scheduleEffort({
                scoredTier: tier,
                recentCalls: calls,
                allowToolUpgrade: cfg.allowToolUpgrade,
                selected: 'auto',
                defaultTier: 'high',
            });
            // The scheduled path can only ever produce low/high/max (never off,
            // never medium); only a manual passthrough may carry `off`, handled
            // by the forced-thinking clamp below.
            if (!decision.manual)
                assertAutoTier(decision.effort, 'dsh-effort-auto-toggle scheduler');
            // 0.2.0: the scheduler speaks SEMANTIC tiers (low/high/max); map
            // them onto the real levels of this model ("high" may land on
            // "highx", "max" on "ultra", a 2-level model collapses, ...).
            effort = decision.manual ? decision.effort : semanticToLadder(decision.effort, ladder);
            if (!decision.manual)
                assertScheduledEffort(effort, ladder, 'dsh-effort-auto-toggle scheduler');
            reason = decision.reason;
        }
        else {
            reason = 'idle (auto button off, manual effort)';
        }
        // 3) Resolve the effort that actually goes on the wire.
        //
        // Invariants — each one is a real provider rejection, not a taste call:
        //   * `auto` must NEVER reach the provider: it is a phantom tier that
        //     only exists while a plugin advertises it (the provider answers
        //     UNSUPPORTED_REASONING_EFFORT). It can still be sitting in the
        //     selection after the toggle went dark, after a plugin reload or a
        //     session resume, so the passthrough path sanitises it as well.
        //   * `off` must not reach a forced-thinking model (GLM-5.3 family):
        //     clamp it to `low`.
        let finalEffort = effort;
        let clamped = false;
        let sanitized = false;
        let restore = false;
        if (plan.mode === 'passthrough') {
            const wire = isPickableEffort(selected, ladder) ? selected : undefined;
            // A genuine manual pick (an echo of our own override is never one).
            if (!echoOfOverride && wire !== undefined && wire !== 'off' && manualPick.effort !== wire)
                manualPick = { sessionId, effort: wire };
            const savedPre = isPickableEffort(lastOverride.preAutoEffort, ladder) ? lastOverride.preAutoEffort : undefined;
            const wasArmed = lastOverride.autoOn === true;
            if (wasArmed) {
                // Disarm edge: forget the override so the next seed is trusted.
                lastOverride = { sessionId: null, effort: undefined, autoOn: false, preAutoEffort: undefined, ts: Date.now() };
                persistOverrideState(lastOverride);
            }
            if (wire !== undefined) {
                if (wasArmed && echoOfOverride && savedPre !== undefined) {
                    // The seed is the echo of our own last auto override: put the
                    // manual effort back instead of keeping the auto pick.
                    finalEffort = savedPre;
                    sanitized = true;
                    restore = true;
                    reason = 'auto disarmed: restoring pre-auto manual effort';
                }
                else {
                    finalEffort = wire;
                }
            }
            else if (selected === undefined || selected === null) {
                finalEffort = undefined; // nothing selected: leave the seed alone
            }
            else {
                // An unsupported value is on the wire (`auto`, `medium`, junk).
                finalEffort = savedPre ?? (isPickableEffort(manualPick.effort, ladder) ? manualPick.effort : undefined) ?? semanticToLadder('high', ladder);
                sanitized = true;
                reason = `unsupported effort ${JSON.stringify(String(selected))} sanitised -> ${finalEffort}`;
                ctx.logger?.warn?.('[effort-auto-toggle] effort "%s" is not accepted by the provider; sending "%s" instead', String(selected), finalEffort);
            }
        }
        if (finalEffort === 'off' && cfg.clampForcedThinkingOff) {
            const clamp = clampForModel(finalEffort, model, ladder);
            if (clamp.clamped) {
                finalEffort = clamp.effort;
                clamped = true;
                sanitized = true;
                reason = `${reason}; off->low clamp (forced-thinking model)`;
            }
        }
        if (clamped)
            ctx.logger?.warn?.('[effort-auto-toggle] %s is a forced-thinking model (GLM-5.3 etc.); off would be rejected, clamped to low', model || '(unknown model)');
        if (plan.mode === 'passthrough') {
            ctx.logger?.info?.('[effort-auto-toggle] agent/request: plan=passthrough selected=%s%s%s', String(selected), sanitized ? ` -> ${finalEffort}` : '', restore ? ' (restored)' : '');
            if (!sanitized)
                return seed; // untouched manual selection
        }
        else {
            ctx.logger?.info?.('[effort-auto-toggle] agent/request: plan=%s selected=%s scored=%s(%s,%d) => effort=%s', plan.mode, String(selected), tier, classifierSource, classifierScore, String(finalEffort));
        }
        // 4) Remember the decision for this step's usage record.
        const turnStep = readTurnStep(events, payload);
        if (turnStep !== undefined) {
            pending.set(turnStep.key, { tier, effort: finalEffort ?? 'high', reason, classifierSource, classifierScore });
            if (pending.size > 128) {
                const oldest = pending.keys().next().value;
                if (oldest !== undefined)
                    pending.delete(oldest);
            }
        }
        if (finalEffort === undefined)
            return seed;
        if (plan.mode === 'schedule') {
            // Arming edge: remember the manual effort that was live before the
            // first auto override, so disarming can put it back.
            const preAuto = lastOverride.autoOn === true
                ? lastOverride.preAutoEffort
                : (isWireEffort(selected) === true && selected !== 'off' ? selected : undefined);
            lastOverride = { sessionId, effort: finalEffort, autoOn: true, preAutoEffort: preAuto, ts: Date.now() };
            persistOverrideState(lastOverride);
        }
        return { ...seed, reasoningEffort: finalEffort };
    }, { prepend: true });
}

let overrideStateDir = null;
function overrideStatePath() {
    return join(overrideStateDir || join(homedir(), ".dsh", "effort-auto-toggle"), "override-state.json");
}
function loadOverrideState() {
    try {
        const raw = JSON.parse(readFileSync(overrideStatePath(), "utf8"));
        if (raw && typeof raw === "object" && typeof raw.sessionId !== "undefined") {
            return {
                sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
                effort: typeof raw.effort === "string" ? raw.effort : undefined,
                autoOn: raw.autoOn === true,
                preAutoEffort: typeof raw.preAutoEffort === "string" ? raw.preAutoEffort : undefined,
                ts: typeof raw.ts === "number" ? raw.ts : 0,
            };
        }
    } catch {}
    return { sessionId: null, effort: undefined, autoOn: false, preAutoEffort: undefined, ts: 0 };
}
function persistOverrideState(state) {
    try {
        mkdirSync(dirname(overrideStatePath()), { recursive: true });
        writeFileSync(overrideStatePath(), JSON.stringify(state));
    } catch {}
}
function readEvents(agent) {
    if (typeof agent !== 'object' || agent === null)
        return [];
    const session = agent.session;
    if (typeof session !== 'object' || session === null)
        return [];
    const events = session.events;
    return Array.isArray(events) ? events : [];
}
/** Session id of a broadcast `session/event` subject (null when unattributable). */
function sessionIdOfEvent(session) {
    if (typeof session !== "object" || session === null)
        return null;
    const id = session.id ?? session.sessionId;
    return typeof id === "string" && id.length > 0 ? id : null;
}
function plan_echoCheck(lastOverride, manualPick, selected, sessionId) {
    if (typeof selected !== "string") return false;
    if (selected === "off" || selected === "auto") return false;
    if (isWireEffort(selected) !== true) return false;
    if (lastOverride.sessionId !== sessionId) return false;
    if (lastOverride.effort !== selected) return false;
    if (manualPick.sessionId === sessionId && manualPick.effort === selected) return false;
    if (Date.now() - lastOverride.ts > 30 * 60 * 1000) return false;
    return true;
}
function readTurnStep(events, payload) {
    const fromPayload = readNumbers(payload.turn) && readNumbers(payload.step);
    if (fromPayload) {
        return { key: `${payload.turn}:${payload.step}`, turn: payload.turn, step: payload.step };
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (typeof event !== 'object' || event === null)
            continue;
        if (event.type !== 'step/start')
            continue;
        const data = event.data;
        if (typeof data !== 'object' || data === null)
            continue;
        const turn = data.turn;
        const step = data.step;
        if (typeof turn === 'number' && typeof step === 'number') {
            return { key: `${turn}:${step}`, turn, step };
        }
    }
    return undefined;
}
function readNumbers(...values) {
    return values.every(value => typeof value === 'number');
}
export async function reportFor(sessionId, dir) {
    const { buildReport, renderReport } = await import("./ledger.js");
    const ledger = new Ledger(dir || defaultLedgerDir());
    overrideStateDir = dir || defaultLedgerDir();
    const records = await ledger.read(sessionId);
    return renderReport(buildReport(records));
}
export const __classify = {
    minimax: (text, options, fetchImpl) => minimaxClassify(text, options, fetchImpl),
};
