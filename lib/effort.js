/**
 * Effort tiers for dsh-effort-auto-toggle.
 *
 * The plugin's auto tiers are ONLY `low` / `high` / `max` — never `off`
 * (thinking disable is a manual choice, and GLM-5.3 rejects it outright:
 * forced-thinking model) and never `medium` (not a valid wire level in dsh;
 * GLM-5.3 errors on it directly). This module is the single choke point that
 * keeps those invariants: `assertAutoTier`, `clampForModel`, `isWireEffort`.
 *
 * Kept dependency-free so the policy is unit-testable in isolation.
 */
/** All auto tiers in schedule order (cheap -> heavy). */
export const AUTO_TIERS = ['low', 'high', 'max'];
/** Runtime guard: a wire effort dsh understands. */
export function isWireEffort(value) {
    return value === 'off' || value === 'low' || value === 'high' || value === 'max';
}
/** Runtime guard: a tier the auto scheduler may emit. */
export function isAutoTier(value) {
    return value === 'low' || value === 'high' || value === 'max';
}
/**
 * 0.2.0 — model-adaptive effort ladders.
 *
 * Different models expose different reasoning effort sets ("low/high/max",
 * "low/high/highx/max/ultra", ...). The scheduler keeps its SEMANTIC tiers
 * (low = cheap, high = involved, max = heaviest) and maps them onto the
 * target model's real ladder, learned from the host `llm` service
 * (`resolveModelInfo(provider, model).reasoning.efforts`).
 */
/** Effort ids that mean "thinking disabled" — never picked by the scheduler. */
const OFF_LIKE_IDS = new Set(['off', 'none', 'disabled', 'minimal']);
/** Fallback ladder when the model capability is unknown (classic 3-tier). */
export const DEFAULT_LADDER = ['low', 'high', 'max'];
/** Is this id a "thinking off" style level? */
export function isOffLikeId(id) {
    return typeof id === 'string' && OFF_LIKE_IDS.has(id);
}
/**
 * Build the schedulable ladder from `LlmModelReasoningInfo.efforts`
 * (array of {id, name, ...}): drop off-like ids, keep adapter order
 * (adapters list levels light -> heavy; the model picker renders the same
 * order). Empty/invalid input falls back to DEFAULT_LADDER.
 */
export function buildLadder(efforts) {
    if (!Array.isArray(efforts))
        return DEFAULT_LADDER.slice();
    const ladder = [];
    for (const e of efforts) {
        const id = e && typeof e === 'object' ? e.id : e;
        if (typeof id !== 'string' || id.length === 0 || isOffLikeId(id))
            continue;
        if (!ladder.includes(id))
            ladder.push(id);
    }
    return ladder.length > 0 ? ladder : DEFAULT_LADDER.slice();
}
/**
 * Map a semantic tier onto a ladder index.
 * low -> lightest (0); max -> heaviest (n-1);
 * high -> upper-middle: n<=2 -> n-1, else floor((n-1)*2/3)
 * (n=3 -> 1 "high"; n=4 -> 2; n=5 "low,high,highx,max,ultra" -> 2 "highx").
 */
export function semanticToLadder(semantic, ladder) {
    const n = ladder.length;
    if (n === 0)
        return 'high';
    if (semantic === 'low')
        return ladder[0];
    if (semantic === 'max')
        return ladder[n - 1];
    return ladder[n <= 2 ? n - 1 : Math.floor(((n - 1) * 2) / 3)];
}
/**
 * Reverse map: an actual effort id back to the semantic tier for the ledger.
 * Unknown ids keep the legacy wire-name heuristic.
 */
export function guessSemantic(effort, ladder) {
    if (typeof effort !== 'string')
        return 'high';
    const idx = ladder.indexOf(effort);
    if (idx >= 0) {
        if (idx === 0)
            return 'low';
        if (idx === ladder.length - 1 && ladder.length > 1)
            return 'max';
        return 'high';
    }
    return effort === 'low' || effort === 'max' ? effort : 'high';
}
/** Is this a value the manual picker could have chosen (on this model)? */
export function isPickableEffort(effort, ladder) {
    if (effort === 'off')
        return true;
    if (typeof effort !== 'string')
        return false;
    if (Array.isArray(ladder) && ladder.includes(effort))
        return true;
    return isWireEffort(effort);
}
/** Fail-loud: a scheduled effort must be a real level of this model. */
export function assertScheduledEffort(effort, ladder, where) {
    if (!Array.isArray(ladder) || !ladder.includes(effort)) {
        throw new TypeError(`${where}: scheduled effort ${JSON.stringify(effort)} is not a level of this model (${JSON.stringify(ladder)})`);
    }
}
/** Fail-loud validation for external input claiming to be an auto tier. */
export function assertAutoTier(value, where) {
    if (!isAutoTier(value)) {
        throw new TypeError(`${where}: invalid auto tier ${JSON.stringify(value)} (expected low | high | max — off/medium are never auto-picked)`);
    }
}
/**
 * Models that force thinking on (GLM-5.3 family and GLM-4.7):
 * `thinking.type: disabled` errors at the provider, so a manual `off`
 * selection must be clamped to the lightest real tier (`low`) instead of
 * riding through to an API failure. GLM-5.1/5.2 auto-judge thinking and
 * still accept disabled — they are intentionally NOT matched.
 */
const FORCED_THINKING_MODEL_RE = /glm[-_ .]?(?:5\.(?:[3-9]|\d{2,})|4\.7)/i;
/** Does this model id belong to a forced-thinking family (GLM-5.3 etc.)? */
export function isForcedThinkingModel(model) {
    if (typeof model !== 'string' || model.length === 0)
        return false;
    return FORCED_THINKING_MODEL_RE.test(model);
}
/**
 * Clamp an effort for the target model.
 *
 * - forced-thinking models (GLM-5.3): `off` -> `low` (the provider would
 *   reject a thinking-disable), everything else passes through;
 * - other models: pass-through.
 *
 * @returns the clamped wire effort plus whether a clamp happened.
 */
export function clampForModel(effort, model, ladder) {
    if (effort === 'off' && isForcedThinkingModel(model)) {
        const lightest = Array.isArray(ladder) && ladder.length > 0 ? ladder[0] : 'low';
        return { effort: lightest, clamped: true };
    }
    return { effort, clamped: false };
}
