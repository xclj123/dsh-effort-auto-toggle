/**
 * Price catalog and cost arithmetic for the ledger report.
 *
 * Three slots per million tokens: `inputMiss` (uncached input — exactly what
 * `TokenUsage.inputTokens` holds, the host reports usage counts DISJOINT),
 * `cacheRead`, `output`. `cacheWrite` has no published slot of its own; it is
 * charged at the `inputMiss` rate, the conservative reading of "a cache write
 * costs at most a full input token".
 *
 * Prices are data, not policy: they are resolved at report time and never
 * stamped into a ledger row, so correcting a price re-prices the whole history.
 * Anything the catalog does not cover is reported as 未计价 instead of guessed.
 */
/** One rate card, per million tokens, in the entry's currency. */
export interface RateCard {
    inputMiss: number;
    cacheRead: number;
    output: number;
}
/** One catalog entry. `flat` = one price all day; `peak`/`offPeak` = time-of-day. */
export interface PriceEntry {
    key: string;
    aliases: string[];
    flat?: RateCard;
    peak?: RateCard;
    offPeak?: RateCard;
    currency: string;
    asOf: string;
    source: string;
}
/** A resolved price: which entry matched, in which currency, at which rate card. */
export interface ResolvedPrice {
    key: string;
    currency: string;
    row: RateCard;
    source: string;
    asOf: string;
}
/** Cost of one ledger row, split by slot (all in `price.currency`). */
export interface RowCost {
    currency: string;
    inputMiss: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    total: number;
}
/** Supported currencies; anything else is reported as the entry's own code. */
export declare const PRICE_CURRENCIES: readonly string[];
/** Every catalog entry (deepseek / glm / minimax / kimi / qwen / doubao). */
export declare const PRICE_CATALOG: readonly PriceEntry[];
/** DeepSeek's peak window (Beijing time, weekdays; holidays are NOT modelled). */
export declare function isPeakBeijing(time: number | Date): boolean;
/**
 * Resolve the price for one provider/model, or `undefined` when nothing covers
 * it. Overrides win, matched by `provider|model`, then `model`, then provider;
 * catalog aliases match on segment boundaries (`glm-5` never catches `glm-5.3`),
 * longest alias first.
 *
 * @param overrides - raw `prices.json` text, or the already-parsed object.
 */
export declare function priceFor(provider: string, model: string, overrides?: string | Record<string, unknown>, time?: number | Date): ResolvedPrice | undefined;
/** Cost of one ledger row, or `undefined` when the model has no price. */
export declare function costOf(record: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}, price: ResolvedPrice | undefined): RowCost | undefined;
