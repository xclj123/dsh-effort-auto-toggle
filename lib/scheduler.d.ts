/**
 * Turn scheduler for dsh-effort-auto-toggle.
 *
 * Combines two signals into the wire effort for the next `agent/request`:
 *
 * 1. the MiniMax (or heuristic) complexity tier scored on the LAST user
 *    message of the turn — memoized per message so one user turn costs at
 *    most one scorer call;
 * 2. the recent tool-call payload heft inside the turn: a heavy payload buys
 *    rungs on the low -> high -> max ladder (0.3.4; it used to be a binary
 *    switch at 3200 characters, which left 800-3199 a no-op dead zone). A
 *    payload can only UPGRADE the tier, never downgrade the scored tier.
 *
 * Manual wire picks in the model selector always win (the plugin only
 * intervenes for the `auto` mask or when nothing was selected).
 */
import type { AutoTier, WireEffort } from './effort.ts';
import type { ClassifyResult } from './classifier.ts';
/** The plugin-level picker value: `auto` enables the scorer; a wire level forces it. */
export type PluginLevel = 'auto' | WireEffort;
/** Runtime guard for the picker value. */
export declare function isPluginLevel(value: unknown): value is PluginLevel;
/**
 * The intervention plan for one request, decided BEFORE any scorer call so
 * the MiniMax component only ever runs when both pickers agree on `auto`:
 *
 * - `force`      — the plugin card carries a manual wire level: inject it on
 *                  every request, no scorer;
 * - `schedule`   — card is `auto` AND the session model selector is `auto`:
 *                  run the scorer and schedule;
 * - `passthrough`— anything else (selector manual or unset): the plugin does
 *                  not touch the request (the selector value rides through).
 */
export type RequestPlan = {
    mode: 'force';
    effort: WireEffort;
} | {
    mode: 'schedule';
} | {
    mode: 'passthrough';
};
/**
 * Decide the intervention mode from the two picker sources. Pure and
 * unit-tested: the expensive path (MiniMax scoring) is reachable ONLY
 * through `{ mode: 'schedule' }`.
 */
export declare function planRequest(cardLevel: unknown, selected: unknown): RequestPlan;
/** A tool call at or above this many argument characters buys one rung. */
export declare const HEAVY_ARGS: 800;
/** A tool call at or above this many argument characters buys two rungs. */
export declare const VERY_HEAVY_ARGS: number;
/**
 * How many rungs a tool payload buys: 0 below {@link HEAVY_ARGS}, 1 at or above
 * it, 2 at or above {@link VERY_HEAVY_ARGS}. Two rungs is the ceiling.
 */
export declare function rungsForArgs(heaviest: number): 0 | 1 | 2;
/** One observed tool call of the current step (defensive subset). */
export interface ToolCallSample {
    name: string;
    argsSize: number;
}
/** Everything the scheduler needs for one request decision. */
export interface SchedulerInput {
    /** The tier scored for the turn's last user message (undefined = no score). */
    scoredTier: AutoTier | undefined;
    /** Recent tool calls of the step (oldest first); empty for a fresh prompt. */
    recentCalls: readonly ToolCallSample[];
    /** May heavy tool payloads upgrade the tier up to `max`. */
    allowToolUpgrade: boolean;
    /** The selected effort: a wire level, or `auto` for scheduling. */
    selected: unknown;
    /** Default tier when nothing was selected. */
    defaultTier: AutoTier;
}
/** Why the scheduler picked the tier — lands in the ledger. */
export interface SchedulerDecision {
    /** Wire effort for the request; `off` only via manual passthrough. */
    effort: WireEffort;
    reason: string;
    upgradedByToolLoad: boolean;
    /** True when a manual model-selector pick passed through unchanged. */
    manual: boolean;
}
/**
 * Resolve the wire effort for the next request.
 *
 * Rules:
 * - a manual wire pick (off/low/high/max) returns unchanged — manual wins;
 * - `auto` (or nothing selected) schedules: the scored tier, lifted by
 *   {@link rungsForArgs} rungs when upgrades are allowed, saturating at `max`;
 * - the result is always one of low/high/max — never off, never medium.
 */
export declare function scheduleEffort(input: SchedulerInput): SchedulerDecision;
/**
 * Memoized per-message scorer wrapper: one user message -> one classify call.
 * The cache key is the message text itself (trimmed), capped in size.
 */
export declare class TurnScoreCache {
    private readonly cache;
    private readonly order;
    private readonly capacity;
    constructor(capacity?: number);
    /** Remember a scored result for a message text. */
    remember(text: string, result: ClassifyResult): void;
    /** Fetch a remembered result, if any. */
    lookup(text: string): ClassifyResult | undefined;
    /** Current cache size (telemetry/tests). */
    get size(): number;
}
/**
 * Negative cache for a failing scorer endpoint (0.3.4).
 *
 * A scorer failure is not a verdict, so it must not be memoized as one — but
 * without a backoff every later step in the same turn re-pays the full timeout
 * against a dead endpoint. Marking the message text cools the SAME message down
 * for {@link ScorerBackoff.cooldownMs} while other messages still get a fresh
 * attempt, and the entry expires on its own so the scorer is retried later.
 */
export declare class ScorerBackoff {
    /** Message fingerprint -> epoch ms at which the cooldown expires. */
    readonly until: Map<string, number>;
    readonly cooldownMs: number;
    constructor(cooldownMs?: number);
    /** Remember that the scorer failed for this text. Bounded at 128 entries. */
    markFailed(text: string): void;
    /** True while the scorer should be skipped for this text. */
    cooling(text: string): boolean;
}
