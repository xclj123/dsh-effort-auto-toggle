/**
 * Effort ladders for dsh-effort-auto-toggle.
 *
 * Since 0.2.0 the scheduler is model-adaptive: instead of a hard-coded
 * low/high/max set it asks the host llm service for the model's real
 * reasoning-effort list (e.g. glm-5.3 is low/high/max; other models may be
 * low/high/highx/max/ultra) and maps its three semantic tiers onto that
 * ladder. This module owns the ladder math:
 *
 * - `buildLadder` normalises the adapter effort list (drops off-like ids,
 *   keeps adapter order which runs light -> heavy, dedupes, falls back to
 *   DEFAULT_LADDER);
 * - `semanticToLadder` places a semantic tier (low/high/max) on the ladder;
 * - `guessSemantic` maps a real effort id back to a semantic tier (ledger).
 *
 * Wire-level invariants are still enforced here: `off` stays manual-only
 * (GLM-5.3 rejects thinking-disable outright) and `medium` is never emitted.
 *
 * Kept dependency-free so the policy is unit-testable in isolation.
 */
/** Wire effort levels dsh understands (llm-deepseek contract). */
export type WireEffort = 'off' | 'low' | 'high' | 'max';
/** Semantic tiers the scheduler reasons in. */
export type AutoTier = 'low' | 'high' | 'max';
/** All semantic tiers in schedule order (light -> heavy). */
export declare const AUTO_TIERS: readonly AutoTier[];
/** Fallback ladder when the llm service is unavailable (3 rungs). */
export declare const DEFAULT_LADDER: readonly string[];
/** Effort ids that mean "thinking off" (manual-only, dropped from ladders). */
export declare function isOffLikeId(id: string): boolean;
/**
 * Normalise a model's adapter effort list into a scheduling ladder:
 * drops off-like ids, keeps adapter order (light -> heavy), dedupes,
 * and falls back to DEFAULT_LADDER when nothing pickable remains.
 */
export declare function buildLadder(efforts: unknown): string[];
/**
 * Place a semantic tier on a ladder.
 * low -> first rung, max -> last rung, high -> index floor((n-1)*2/3)
 * (3 rungs -> middle, 4 -> third, 5 -> third). Returns the DEFAULT_LADDER
 * placement when the ladder is empty.
 */
export declare function semanticToLadder(semantic: AutoTier, ladder: readonly string[]): string;
/**
 * Reverse mapping for the ledger: first rung -> low, last -> max,
 * middle -> high, ids outside the ladder fall back to the AUTO_TIERS
 * whitelist.
 */
export declare function guessSemantic(effort: string | undefined, ladder: readonly string[]): AutoTier;
/** May this effort be forwarded as-is for this model? ('off' always: manual.) */
export declare function isPickableEffort(effort: string, ladder: readonly string[]): boolean;
/** Fail-loud check that a scheduled effort is a real rung of this ladder. */
export declare function assertScheduledEffort(effort: string, ladder: readonly string[], where: string): void;
/** Runtime guard: a wire effort dsh understands. */
export declare function isWireEffort(value: unknown): value is WireEffort;
/** Runtime guard: a semantic tier the scheduler may emit. */
export declare function isAutoTier(value: unknown): value is AutoTier;
/** Fail-loud validation for external input claiming to be an auto tier. */
export declare function assertAutoTier(value: unknown, where: string): asserts value is AutoTier;
/** Does this model id belong to a forced-thinking family (GLM-5.3 etc.)? */
export declare function isForcedThinkingModel(model: string | undefined): boolean;
/**
 * Clamp an effort for the target model.
 *
 * - forced-thinking models (GLM-5.3): `off` -> the ladder's lightest rung
 *   (default 'low') — the provider would reject a thinking-disable;
 * - other models: pass-through.
 */
export declare function clampForModel(effort: WireEffort, model: string | undefined, ladder?: readonly string[]): {
    effort: WireEffort;
    clamped: boolean;
};
