/**
 * Complexity classifier for dsh-effort-auto-toggle.
 *
 * Two backends, mirroring hermes-plugin-effort-auto-toggle's tier design
 * (score each user message -> low / high / max) but with a MiniMax LLM as the
 * primary scorer instead of local embeddings:
 *
 * 1. `minimax`  — a chat-completions call with thinking disabled (the only
 *                 reliable way per MiniMax docs: `thinking: {type:"disabled"}`),
 *                 tiny max_tokens, strict JSON out. Fast, cheap, no local model.
 * 2. `heuristic` — zero-dependency fallback (also used on timeout / HTTP /
 *                 parse failure / missing key): length + code blocks + heavy
 *                 keywords + question pressure.
 *
 * Pure inputs -> output; the fetch is injected so tests can stub it.
 */
import { type AutoTier } from './effort.ts';
/** One classification result: the tier plus where it came from. */
export interface ClassifyResult {
    tier: AutoTier;
    /** 0-100 complexity score when available (heuristic always, minimax best-effort). */
    score: number;
    /** Which backend produced the tier. */
    source: 'minimax' | 'heuristic';
    /** Human-readable note (failure reason when falling back). */
    note?: string;
}
/** Minimal fetch face so tests can inject a stub. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
/** MiniMax backend settings (resolved from plugin config + env). */
export interface MinimaxOptions {
    apiKey: string;
    baseUrl: string;
    model: string;
    timeoutMs: number;
}
/**
 * Extract the first JSON object from a string (scorers sometimes wrap JSON
 * in prose or fences despite instructions).
 */
export declare function extractJson(raw: string): Record<string, unknown> | undefined;
/** Map a 0-100 score to the three auto tiers. */
export declare function scoreToTier(score: number): AutoTier;
/**
 * Zero-dependency heuristic score for a user message.
 *
 * Signals: length, fenced code blocks, heavy/simple keywords, question marks,
 * attached file count (@-mentions). Deterministic; unit-testable.
 */
export declare function heuristicScore(text: string): number;
/** The heuristic result on its own (fallback path). */
export declare function heuristicClassify(text: string, note?: string): ClassifyResult;
/**
 * Classify one user message with the MiniMax backend.
 *
 * Never throws: any failure (missing key, timeout, HTTP error, unparsable
 * body) degrades to the heuristic result with a note. Thinking is disabled on
 * the scorer call (`thinking: {type:"disabled"}`) — the documented MiniMax
 * switch — because scoring must stay fast and cheap.
 *
 * @param text - the user message to score.
 * @param options - resolved MiniMax settings.
 * @param fetchImpl - fetch to use (injectable for tests).
 */
export declare function minimaxClassify(text: string, options: MinimaxOptions, fetchImpl?: FetchLike): Promise<ClassifyResult>;
