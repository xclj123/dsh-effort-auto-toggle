/**
 * Session event sampling for dsh-effort-auto-toggle.
 *
 * Defensive extraction from the session event log handed over by the host —
 * the part most exposed to dsh event-shape drift — kept unit-testable in
 * isolation with explicit guards instead of naked type assertions.
 *
 * The log itself is read by `readEvents()` in `index.js`: dsh 0.2.2-rc.3
 * removed the `session.events` getter, so the reader probes
 * `snapshotEvents()` / `ownEvents()` / `eventAt()` and only then the legacy
 * array. Shapes verified against dsh-session + dsh-llm (0.2.2-rc.3):
 *
 * - `user/message`      data = the message object (role/content blocks)
 * - `assistant/message` data = { turn, step, message: { source: { provider,
 *                        model } }, usage?: { inputTokens, outputTokens } }
 * - `tool/call`         data = { name, arguments, ... }
 */
/** A defensively-read tool call sample. */
export interface SampledToolCall {
    name: string;
    argsSize: number;
}
/** A defensively-read per-step usage record. */
export interface SampledUsage {
    turn: number;
    step: number;
    provider: string;
    model: string;
    /** Prompt tokens served from the cache (disjoint from `inputTokens`). */
    cacheReadTokens: number;
    /** Prompt tokens written into the cache (disjoint from `inputTokens`). */
    cacheWriteTokens: number;
    inputTokens: number;
    outputTokens: number;
}
/** The latest user text plus how many user messages were seen. */
export interface LatestUserMessage {
    text: string;
    index: number;
}
/** Extract the flat text of a message's content blocks (best effort). */
export declare function messageText(message: unknown): string;
/** The last `user/message` event's text, oldest-first index. */
export declare function latestUserMessage(events: readonly unknown[]): LatestUserMessage | undefined;
/** Recent tool calls (oldest first), at most `window` samples. */
export declare function recentToolCalls(events: readonly unknown[], window?: number): SampledToolCall[];
/**
 * All `assistant/message` usage records at or after `fromIndex` (exclusive),
 * oldest first — the ledger's token source. Steps whose adapter reported no
 * usage are skipped rather than zero-filled.
 */
export declare function usageSince(events: readonly unknown[], fromIndex: number): SampledUsage[];
/** A session id read defensively off the `agent` payload value. */
export declare function sessionIdOf(agent: unknown): string;
