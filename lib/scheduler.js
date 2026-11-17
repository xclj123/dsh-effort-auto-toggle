/**
 * Turn scheduler for dsh-effort-auto-toggle.
 *
 * Combines two signals into the wire effort for the next `agent/request`:
 *
 * 1. the MiniMax (or heuristic) complexity tier scored on the LAST user
 *    message of the turn — memoized per message so one user turn costs at
 *    most one scorer call;
 * 2. the recent tool-call payload heft inside the turn (borrowed from
 *    dsh-thinking-levels' thresholds): a very heavy payload can only UPGRADE
 *    the tier (never downgrade the scored tier).
 *
 * Manual wire picks in the model selector always win (the plugin only
 * intervenes for the `auto` mask or when nothing was selected).
 */
import { isAutoTier, isWireEffort } from "./effort.js";
/** Runtime guard for the picker value. */
export function isPluginLevel(value) {
    return value === 'auto' || isWireEffort(value);
}
/**
 * Decide the intervention mode from the two picker sources. Pure and
 * unit-tested: the expensive path (MiniMax scoring) is reachable ONLY
 * through `{ mode: 'schedule' }`.
 */
export function planRequest(cardLevel, selected) {
    if (cardLevel !== 'auto') {
        return isWireEffort(cardLevel)
            ? { mode: 'force', effort: cardLevel }
            : { mode: 'passthrough' };
    }
    return selected === 'auto' ? { mode: 'schedule' } : { mode: 'passthrough' };
}
/** Payload heft that signals non-trivial work (chars; dsh-thinking-levels value). */
export const HEAVY_ARGS = 800;
/** Very heavy context: two rungs, i.e. straight to the top. */
export const VERY_HEAVY_ARGS = HEAVY_ARGS * 4;
const TIER_ORDER = { low: 0, high: 1, max: 2 };
const TIER_LADDER = ['low', 'high', 'max'];
/**
 * How many rungs a tool payload buys. 0.3.4: this used to be a binary switch at
 * 3200 chars, so anything between 800 and 3199 was logged as "below the upgrade
 * threshold" and changed nothing — a real tool payload of 2000 characters was
 * indistinguishable from no tool call at all. Any payload at or above
 * {@link HEAVY_ARGS} now buys one rung, and {@link VERY_HEAVY_ARGS} buys two.
 */
export function rungsForArgs(heaviest) {
    if (heaviest >= VERY_HEAVY_ARGS)
        return 2;
    if (heaviest >= HEAVY_ARGS)
        return 1;
    return 0;
}
/**
 * Resolve the wire effort for the next request.
 *
 * Rules:
 * - a manual wire pick (off/low/high/max) returns unchanged — manual wins;
 * - `auto` (or nothing selected) schedules: scored tier, upgraded to `max`
 *   when a recent tool call carried a very heavy payload and upgrades are
 *   allowed;
 * - the result is always one of low/high/max — never off, never medium.
 */
export function scheduleEffort(input) {
    if (input.selected === 'off' || input.selected === 'low'
        || input.selected === 'high' || input.selected === 'max') {
        return { effort: input.selected, reason: '手动档位优先', upgradedByToolLoad: false, manual: true };
    }
    // `auto`, nothing selected, or an unknown value: schedule from the scored
    // tier (falling back to the default tier when no score made it here).
    const base = input.scoredTier ?? input.defaultTier;
    if (!isAutoTier(base)) {
        return { effort: 'high', reason: '兜底：未识别的档位，回落 high', upgradedByToolLoad: false, manual: false };
    }
    const heaviest = input.recentCalls.reduce((max, call) => Math.max(max, call.argsSize), 0);
    const rungs = input.allowToolUpgrade ? rungsForArgs(heaviest) : 0;
    const baseIndex = TIER_ORDER[base];
    const targetIndex = Math.min(TIER_LADDER.length - 1, baseIndex + rungs);
    const upgraded = targetIndex > baseIndex;
    const effort = upgraded ? TIER_LADDER[targetIndex] : base;
    const reason = upgraded
        ? `工具负载升级（最大参数 ${heaviest} 字符，升 ${targetIndex - baseIndex} 档至 ${effort}）`
        : heaviest >= HEAVY_ARGS && base === 'max'
            ? `按消息复杂度定档（最大参数 ${heaviest} 字符，已在最高档 ${base}）`
            : heaviest > 0
                ? `按消息复杂度定档（近期最大参数 ${heaviest} 字符，未达 ${HEAVY_ARGS} 字符升级线）`
                : '按消息复杂度定档（无近期工具调用）';
    return { effort, reason, upgradedByToolLoad: upgraded, manual: false };
}
/**
 * Memoized per-message scorer wrapper: one user message -> one classify call.
 * The cache key is the message text itself (trimmed), capped in size.
 */
export class TurnScoreCache {
    cache = new Map();
    order = [];
    capacity;
    constructor(capacity = 64) {
        this.capacity = Math.max(1, capacity);
    }
    /** Remember a scored result for a message text. */
    remember(text, result) {
        const key = keyOf(text);
        if (this.cache.has(key))
            return;
        this.cache.set(key, result);
        this.order.push(key);
        while (this.order.length > this.capacity) {
            const oldest = this.order.shift();
            if (oldest !== undefined)
                this.cache.delete(oldest);
        }
    }
    /** Fetch a remembered result, if any. */
    lookup(text) {
        return this.cache.get(keyOf(text));
    }
    /** Current cache size (telemetry/tests). */
    get size() {
        return this.cache.size;
    }
}
function keyOf(text) {
    const trimmed = text.trim();
    return trimmed.length > 512 ? `${trimmed.length}:${trimmed.slice(0, 256)}…${trimmed.slice(-128)}` : trimmed;
}
/**
 * Short-lived negative cache for the scorer.
 *
 * A scorer failure is not a verdict, so {@link TurnScoreCache} deliberately does
 * not remember it — the next message must be able to retry. But "the next
 * message" is not the same as "the next step": a single turn fires several
 * request hooks, and a dead endpoint meant every one of them paid the full
 * `scoreTimeoutMs` again. This remembers *the failure* for a short cooldown, so
 * retries happen on a human timescale instead of per step, while the heuristic
 * verdict still applies immediately.
 */
export class ScorerBackoff {
    until = new Map();
    cooldownMs;
    constructor(cooldownMs = 60000) {
        this.cooldownMs = Math.max(0, cooldownMs);
    }
    /** Record that the scorer just failed for this text. */
    markFailed(text) {
        if (this.cooldownMs === 0)
            return;
        this.until.set(keyOf(text), Date.now() + this.cooldownMs);
        if (this.until.size > 128) {
            const oldest = this.until.keys().next();
            if (!oldest.done)
                this.until.delete(oldest.value);
        }
    }
    /** True when the scorer is still in cooldown and should be skipped. */
    cooling(text) {
        const expiry = this.until.get(keyOf(text));
        if (expiry === undefined)
            return false;
        if (Date.now() >= expiry) {
            this.until.delete(keyOf(text));
            return false;
        }
        return true;
    }
}
