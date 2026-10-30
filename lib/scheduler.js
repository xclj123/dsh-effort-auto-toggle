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
const HEAVY_ARGS = 800;
/** Very heavy context: upgrade straight to `max`. */
const VERY_HEAVY_ARGS = HEAVY_ARGS * 4;
const TIER_ORDER = { low: 0, high: 1, max: 2 };
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
    const upgraded = input.allowToolUpgrade && heaviest >= VERY_HEAVY_ARGS && base !== 'max';
    const effort = upgraded && TIER_ORDER.max > TIER_ORDER[base] ? 'max' : base;
    const reason = upgraded
        ? `工具重负载升级（最大参数 ${heaviest} 字符 ≥ ${VERY_HEAVY_ARGS}）`
        : heaviest > 0
            ? `按消息复杂度定档（近期最大参数 ${heaviest} 字符，未达升级阈值）`
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
