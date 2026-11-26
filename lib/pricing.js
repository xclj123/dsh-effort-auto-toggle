/**
 * Price catalog and cost arithmetic for the ledger report.
 *
 * Three slots, per million tokens: `inputMiss` (uncached input — exactly what
 * `TokenUsage.inputTokens` holds, the counts are DISJOINT), `cacheRead`,
 * `output`. `cacheWrite` has no slot of its own in any published table we know
 * of; it is charged at the `inputMiss` rate, which is the conservative reading
 * of every provider's "cache write costs at most a full input token".
 *
 * Prices are data, not policy: they are read from here at report time, never
 * stamped into a ledger row, so correcting a price re-prices the whole history.
 * Entries carry the date they were checked and where they came from; anything
 * not in the table is reported as "未计价" instead of being guessed.
 */
/** DeepSeek's peak window, Beijing time, weekdays (holidays are NOT modelled). */
const PEAK_HOURS = [[9, 12], [14, 18]];
const CNY = 'CNY';
const USD = 'USD';
/**
 * Catalog entries. `flat` = one price all day; `peak`/`offPeak` = DeepSeek's
 * time-of-day schedule. Aliases match on segment boundaries (`glm-5` must not
 * catch `glm-5.3`), longest alias first.
 */
export const PRICE_CATALOG = [
    { key: 'deepseek-v4.1-flash', aliases: ['deepseek-v4.1-flash', 'deepseek-flash'],
        peak: { inputMiss: 2, cacheRead: 0.04, output: 8 }, offPeak: { inputMiss: 1, cacheRead: 0.02, output: 4 },
        currency: CNY, asOf: '2026-10-17', source: 'DeepSeek 官方定价页（峰谷分时，峰窗 09-12/14-18 北京）' },
    { key: 'deepseek-v4-flash', aliases: ['deepseek-v4-flash'],
        peak: { inputMiss: 3, cacheRead: 0.1, output: 9 }, offPeak: { inputMiss: 1.5, cacheRead: 0.05, output: 4.5 },
        currency: CNY, asOf: '2026-08-14', source: 'DeepSeek 官方定价页（峰谷分时）' },
    { key: 'deepseek-v4-pro', aliases: ['deepseek-v4-pro'],
        peak: { inputMiss: 9, cacheRead: 0.3, output: 27 }, offPeak: { inputMiss: 4.5, cacheRead: 0.15, output: 13.5 },
        currency: CNY, asOf: '2026-08-14', source: 'DeepSeek 官方定价页（峰谷分时）' },
    { key: 'deepseek-chat', aliases: ['deepseek-chat'],
        flat: { inputMiss: 2, cacheRead: 0.5, output: 8 }, currency: CNY, asOf: '2026-10-17', source: 'DeepSeek 官方定价页' },
    { key: 'glm-5.2', aliases: ['glm-5.2'], flat: { inputMiss: 8, cacheRead: 2, output: 28 }, currency: CNY, asOf: '2026-10-17', source: '智谱官方定价页' },
    { key: 'glm-5.1', aliases: ['glm-5.1'], flat: { inputMiss: 6, cacheRead: 1.3, output: 24 }, currency: CNY, asOf: '2026-10-17', source: '智谱官方定价页' },
    { key: 'glm-5', aliases: ['glm-5'], flat: { inputMiss: 4, cacheRead: 0.8, output: 18 }, currency: CNY, asOf: '2026-10-17', source: '智谱官方定价页' },
    { key: 'glm-4.7', aliases: ['glm-4.7'], flat: { inputMiss: 2, cacheRead: 0.4, output: 8 }, currency: CNY, asOf: '2026-10-17', source: '智谱官方定价页' },
    { key: 'glm-4.6', aliases: ['glm-4.6'], flat: { inputMiss: 5, cacheRead: 1, output: 5 }, currency: CNY, asOf: '2026-10-17', source: '智谱官方定价页' },
    { key: 'glm-4.5-air', aliases: ['glm-4.5-air'], flat: { inputMiss: 0.8, cacheRead: 0.16, output: 2 }, currency: CNY, asOf: '2026-10-17', source: '智谱官方定价页' },
    { key: 'minimax-m3', aliases: ['minimax-m3'], flat: { inputMiss: 2.1, cacheRead: 0.42, output: 8.4 }, currency: CNY, asOf: '2026-10-17', source: 'MiniMax 官方定价页' },
    { key: 'minimax-m2.7', aliases: ['minimax-m2.7'], flat: { inputMiss: 2.1, cacheRead: 0.42, output: 8.4 }, currency: CNY, asOf: '2026-10-17', source: 'MiniMax 官方定价页' },
    { key: 'kimi-k2.6', aliases: ['kimi-k2.6'], flat: { inputMiss: 6.5, cacheRead: 1.1, output: 27 }, currency: CNY, asOf: '2026-10-17', source: 'Moonshot 官方定价页' },
    { key: 'qwen3-max', aliases: ['qwen3-max'], flat: { inputMiss: 2.5, cacheRead: 0.5, output: 10 }, currency: CNY, asOf: '2026-10-17', source: '阿里云百炼官方定价页' },
    { key: 'qwen3-coder-plus', aliases: ['qwen3-coder-plus'], flat: { inputMiss: 1, cacheRead: 0.2, output: 4 }, currency: CNY, asOf: '2026-10-17', source: '阿里云百炼官方定价页' },
    { key: 'doubao-seed-2.1-pro', aliases: ['doubao-seed-2.1-pro'], flat: { inputMiss: 6, cacheRead: 1.2, output: 30 }, currency: CNY, asOf: '2026-10-17', source: '火山方舟官方定价页' },
];
/** Whether a Beijing-time timestamp falls in a DeepSeek peak window. */
export function isPeakBeijing(time) {
    const date = time instanceof Date ? time : new Date(time);
    const beijing = new Date(date.getTime() + 8 * 3600 * 1000);
    const day = beijing.getUTCDay();
    if (day === 0 || day === 6)
        return false;
    const hour = beijing.getUTCHours();
    return PEAK_HOURS.some(([from, to]) => hour >= from && hour < to);
}
function parseOverrides(source) {
    // `prices.json` arrives already parsed from the report; the settings/CLI path
    // passes the raw JSON text. Accept both, ignore anything malformed.
    if (source !== null && typeof source === 'object')
        return source;
    if (typeof source !== 'string' || source.trim() === '')
        return {};
    try {
        const parsed = JSON.parse(source);
        return parsed !== null && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}
/**
 * Resolve the price for one provider/model, or `undefined` when nothing in the
 * catalog (or the user's overrides) covers it. Overrides win, matched by
 * `provider|model`, then `model`, then longest alias suffix.
 */
export function priceFor(provider, model, overridesText, time) {
    const overrides = parseOverrides(overridesText);
    const exact = [`${provider}|${model}`, model, provider].find((key) => key && overrides[key] !== undefined);
    if (exact !== undefined) {
        const row = overrides[exact];
        if (row && typeof row === 'object') {
            return {
                key: exact,
                currency: typeof row.currency === 'string' ? row.currency : CNY,
                row: {
                    inputMiss: Number(row.inputMiss) || 0,
                    cacheRead: Number(row.cacheRead) || 0,
                    output: Number(row.output) || 0,
                },
                source: 'user override',
                asOf: 'user',
            };
        }
    }
    const lower = String(model || '').toLowerCase();
    // Boundary-aware match, not `includes`: `glm-5` must not price `glm-5.3`,
    // because a confidently wrong number is worse than "未计价".
    const matches = (alias) => lower === alias
        || lower.startsWith(alias + '-') || lower.startsWith(alias + ':') || lower.startsWith(alias + '/')
        || lower.endsWith('-' + alias) || lower.endsWith('/' + alias) || lower.includes('/' + alias + '-');
    let best;
    let bestLength = 0;
    for (const entry of PRICE_CATALOG) {
        for (const alias of entry.aliases) {
            if (alias.length > bestLength && matches(alias)) {
                best = entry;
                bestLength = alias.length;
            }
        }
    }
    if (best === undefined)
        return undefined;
    const row = best.flat !== undefined
        ? best.flat
        : (isPeakBeijing(time === undefined ? Date.now() : time) ? best.peak : best.offPeak);
    return { key: best.key, currency: best.currency, row, source: best.source, asOf: best.asOf };
}
/**
 * Cost of one ledger row. Returns `undefined` when the model has no price, so
 * callers report "未计价" rather than a fabricated number.
 */
export function costOf(record, price) {
    if (price === undefined)
        return undefined;
    const per = 1e6;
    const inputMiss = (record.inputTokens || 0) / per * price.row.inputMiss;
    const cacheRead = (record.cacheReadTokens || 0) / per * price.row.cacheRead;
    // No published slot for cache writes: charge them as fresh input.
    const cacheWrite = (record.cacheWriteTokens || 0) / per * price.row.inputMiss;
    const output = (record.outputTokens || 0) / per * price.row.output;
    return {
        currency: price.currency,
        inputMiss,
        cacheRead,
        cacheWrite,
        output,
        total: inputMiss + cacheRead + cacheWrite + output,
    };
}
export const PRICE_CURRENCIES = [CNY, USD];
