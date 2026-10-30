/**
 * Session event sampling for dsh-effort-auto-toggle.
 *
 * Defensive extraction from `payload.agent.session.events` — the part most
 * exposed to dsh event-shape drift — kept unit-testable in isolation with
 * explicit guards instead of naked type assertions. Shapes verified against
 * deepseek-harness packages/core/agent-loop/src/agent.ts (2026-08):
 *
 * - `user/message`      data = the message object (role/content blocks)
 * - `assistant/message` data = { turn, step, message: { source: { provider,
 *                        model } }, usage?: { inputTokens, outputTokens } }
 * - `tool/call`         data = { name, arguments, ... }
 */
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
/** Extract the flat text of a message's content blocks (best effort). */
export function messageText(message) {
    if (!isRecord(message))
        return '';
    const content = message.content;
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (isRecord(block) && typeof block.text === 'string')
            parts.push(block.text);
    }
    return parts.join('\n');
}
/** The last `user/message` event's text, oldest-first index. */
export function latestUserMessage(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (!isRecord(event) || event.type !== 'user/message')
            continue;
        const text = messageText(event.data);
        if (text.trim().length > 0)
            return { text, index };
    }
    return undefined;
}
/** Recent tool calls (oldest first), at most `window` samples. */
export function recentToolCalls(events, window = 8) {
    const samples = [];
    for (let index = events.length - 1; index >= 0 && samples.length < window; index -= 1) {
        const event = events[index];
        if (!isRecord(event) || event.type !== 'tool/call')
            continue;
        if (!isRecord(event.data))
            continue;
        const name = typeof event.data.name === 'string' && event.data.name.length > 0
            ? event.data.name
            : 'tool';
        samples.push({ name, argsSize: argsSizeOf(event.data.arguments) });
    }
    return samples.reverse();
}
function argsSizeOf(argumentsValue) {
    if (typeof argumentsValue === 'string')
        return argumentsValue.length;
    if (isRecord(argumentsValue) || Array.isArray(argumentsValue)) {
        try {
            return JSON.stringify(argumentsValue).length;
        }
        catch {
            return 0;
        }
    }
    return 0;
}
/**
 * All `assistant/message` usage records at or after `fromIndex` (exclusive),
 * oldest first — the ledger's token source. Steps whose adapter reported no
 * usage are skipped rather than zero-filled.
 */
export function usageSince(events, fromIndex) {
    const records = [];
    for (let index = Math.max(0, fromIndex + 1); index < events.length; index += 1) {
        const event = events[index];
        if (!isRecord(event) || event.type !== 'assistant/message')
            continue;
        if (!isRecord(event.data))
            continue;
        const usage = event.data.usage;
        if (!isRecord(usage))
            continue;
        const inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : NaN;
        const outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : NaN;
        if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens))
            continue;
        const turn = typeof event.data.turn === 'number' ? event.data.turn : 0;
        const step = typeof event.data.step === 'number' ? event.data.step : 0;
        const source = isRecord(event.data.message) && isRecord(event.data.message.source)
            ? event.data.message.source
            : {};
        records.push({
            turn,
            step,
            provider: typeof source.provider === 'string' ? source.provider : 'unknown',
            model: typeof source.model === 'string' ? source.model : 'unknown',
            inputTokens,
            outputTokens,
        });
    }
    return records;
}
/** A session id read defensively off the `agent` payload value. */
export function sessionIdOf(agent) {
    if (!isRecord(agent))
        return 'unknown';
    const session = agent.session;
    if (!isRecord(session))
        return 'unknown';
    const id = session.id;
    if (typeof id === 'string' && id.length > 0)
        return id;
    return 'unknown';
}
