/**
 * dsh-effort-auto-toggle host plugin.
 *
 * A fork of dsh-adaptive-effort with a different arming model: an Auto
 * toggle button next to the model selector in the composer. Lit = the
 * scheduler picks `reasoning_effort` for every request; dim = native manual
 * picking (the effort dropdown stays untouched — no fake "auto" entry is
 * injected, which is what caused UNSUPPORTED_REASONING_EFFORT errors in the
 * original plugin).
 *
 * Since 0.2.0 tiers are model-adaptive: the host `llm` service
 * (resolveModelInfo) supplies the model's real effort list (e.g. glm-5.3 is
 * low/high/max; other adapters may list low/high/highx/max/ultra) and the
 * scheduler maps its three semantic tiers onto that ladder (lightest /
 * upper-middle / heaviest). The lit button and per-reply badges show the
 * real effort id (English, as the adapter names it), sourced live from the
 * modelSelection session projection.
 *
 * Scoring: a MiniMax-compatible chat completion call (thinking disabled —
 * fast and cheap; zero-dependency heuristic fallback when the key/network is
 * unavailable; fallback results are NOT cached so the next message retries
 * the scorer), heavy tool payloads may only upgrade the tier (continuity,
 * session-scoped since 0.1.5), manual wire picks in the model selector
 * always win, and forced-thinking models (GLM-5.3) get a manual `off`
 * clamped to the ladder's lightest rung instead of an API error. Every
 * decision plus the observed per-step token usage lands in a JSONL ledger
 * (~/.dsh/effort-auto-toggle) with a markdown report (lib/report.js).
 *
 * Extension points:
 * - `agent/request` waterfall (registered `prepend` so the session
 *   model-selection assembly cannot overwrite the decision);
 * - `session/event` usage records (the ledger's token source);
 * - `llm` service: resolveModelInfo for per-model effort ladders;
 * - `settings` service (modern describe/update API, ns = profile entry id)
 *   for runtime-adjustable toggles — the volatile fields below.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { minimaxClassify, type ClassifyResult, type FetchLike } from './classifier.ts';
/** Plugin settings (volatile fields are editable on the settings card). */
export interface AdaptiveEffortConfig {
    /** Master switch. */
    enabled: boolean;
    /**
     * The composer Auto button state, persisted through the settings
     * service: lit = auto scheduling on, dim = native manual picking.
     */
    autoOn: boolean;
    /** Scorer backend: `minimax` (LLM) or `heuristic` (zero-dependency). */
    mode: 'minimax' | 'heuristic';
    /** Scorer API key (any OpenAI-compatible chat endpoint). */
    minimaxApiKey: string;
    /** Scorer endpoint (chat-completions base URL). */
    minimaxBaseUrl: string;
    /** Scorer model (any fast model; thinking is disabled on the call). */
    minimaxModel: string;
    /**
     * Scorer call timeout; on expiry fall back to the heuristic (result not
     * cached, so the next message retries the scorer).
     */
    scoreTimeoutMs: number;
    /** Heavy tool payloads may upgrade the tier (continuity, per-session). */
    allowToolUpgrade: boolean;
    /** Clamp a manual `off` to the ladder's lightest rung on GLM-5.3-like models. */
    clampForcedThinkingOff: boolean;
    /** Ledger directory (empty = `~/.dsh/effort-auto-toggle`). */
    ledgerDir: string;
}
/** Composition-entry schema (cordis.yml `config:` of the plugin row). */
export declare const Config: z<AdaptiveEffortConfig>;
/** Settings defaults, kept in lockstep with the schema. */
export declare const DEFAULT_CONFIG: AdaptiveEffortConfig;
/** Locale/legacy dictionary namespace id used by the client bundle. */
export declare const SETTINGS_NAMESPACE = "effort-auto-toggle";
/**
 * Plugin body.
 * @param ctx - host context carrying the agent-event dispatch.
 * @param config - resolved plugin configuration.
 */
export declare function apply(ctx: Context, config?: AdaptiveEffortConfig): void;
/** Exposed for tests: rebuild a ledger-backed report for a session id. */
export declare function reportFor(sessionId: string, dir?: string): Promise<string>;
/** Test seam: classify with an injected fetch (never used by apply()). */
export declare const __classify: {
    minimax: (text: string, options: Parameters<typeof minimaxClassify>[1], fetchImpl: FetchLike) => Promise<ClassifyResult>;
};
