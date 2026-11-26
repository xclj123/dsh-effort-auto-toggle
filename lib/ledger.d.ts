/**
 * Token ledger for dsh-effort-auto-toggle — the effort-router-style accounting
 * half: per-step JSONL records (tier + effort + usage), then a Chinese report
 * with per-level usage, a downshift savings estimate, and misroute flags
 * (lightest-level turns that ballooned, heavy turns that stayed tiny).
 *
 * Storage: one JSONL file per session under the ledger dir
 * (default `~/.dsh/effort-auto-toggle`); append-only, best-effort writes.
 */
import type { AutoTier } from './effort.ts';
/** One plan row: the decision, written before the usage arrives (0.4.0). */
export interface LedgerPlan {
    kind: 'plan';
    ts: string;
    sessionId: string;
    turn: number;
    step: number;
    /** Tier the classifier scored. */
    tier: AutoTier;
    /** Wire effort the scheduler asked for. */
    effort: string;
    reason: string;
    classifierSource: string;
    classifierScore: number;
}
/** Result of one directory scan: usage keys plus the newest plan per step. */
export interface LedgerIndex {
    /** `${sessionId}|${turn}:${step}` for every usage row on disk. */
    keys: Set<string>;
    /** `${turn}:${step}` → newest plan row for that step. */
    plans: Map<string, LedgerPlan>;
}
/** One ledger record — the decision plus the observed usage of that step. */
export interface LedgerRecord {
    ts: string;
    sessionId: string;
    turn: number;
    step: number;
    model: string;
    provider: string;
    /** Tier the classifier scored for the turn. */
    tier: AutoTier;
    /** Wire effort actually injected into the request. */
    effort: string;
    /** Why (scheduler reason or '手动档位优先'). */
    reason: string;
    classifierSource: string;
    classifierScore: number;
    /**
     * Uncached input tokens. dsh reports usage counts disjointly: the cached
     * prompt is `cacheReadTokens` / `cacheWriteTokens`, not part of this field.
     */
    inputTokens: number;
    outputTokens: number;
    /** Prompt tokens served from the cache. */
    cacheReadTokens: number;
    /** Prompt tokens written into the cache. */
    cacheWriteTokens: number;
}
/** Default ledger root. */
export declare function defaultLedgerDir(): string;
/**
 * Append-only ledger sink. Best-effort: write failures are swallowed by the
 * caller-facing `append` (returns success) — accounting must never break the
 * request path.
 */
export declare class Ledger {
    private readonly dir;
    private ready;
    constructor(dir?: string);
    /** Ledger file path for a session (exposed for tests/reporting). */
    pathFor(sessionId: string): string;
    /**
     * Append one record. Serialised through an internal queue, so call order is
     * file order even when the caller never awaits (0.3.4 wrote rows out of
     * order for exactly that reason).
     */
    append(record: LedgerRecord): Promise<unknown>;
    /** Append one plan row (the decision, before its usage arrives). */
    appendPlan(plan: Omit<LedgerPlan, 'kind' | 'ts'> & { ts?: string }): Promise<unknown>;
    /** Read every record of one session file (malformed lines skipped). */
    read(sessionId: string): Promise<LedgerRecord[]>;
    /** List available session ids (files present in the ledger dir). */
    sessions(): Promise<string[]>;
    /**
     * One pass over the ledger dir: every usage key on disk plus the newest plan
     * row per `turn:step`. Used at startup so a restored session is neither
     * replayed nor left unattributed.
     */
    loadIndex(): Promise<LedgerIndex>;
}
/** Parse JSONL text into records, skipping malformed lines. */
export declare function parseLedgerLines(text: string): LedgerRecord[];
/** Token totals shared by both report groupings. */
export interface BucketStats {
    steps: number;
    outputTokens: number;
    /** Uncached input tokens (cached prompt is reported in `cacheReadTokens`). */
    inputTokens: number;
    cacheReadTokens: number;
    meanOutput: number;
    /** Estimated CNY cost of these steps (0 when nothing priced them). */
    costCny: number;
    /** Estimated USD cost of these steps (0 when nothing priced them). */
    costUsd: number;
    /** Steps this bucket could not price (not in the catalog, no override). */
    unpricedSteps: number;
}
/** Total estimated cost of a report, plus how much of it stayed unpriced. */
export interface ReportCost {
    cny: number;
    usd: number;
    unpricedSteps: number;
}
/** Aggregate stats for one wire-effort bucket (`low`, `high`, `highx`, `max`, ...). */
export interface EffortStats extends BucketStats {
    /** Wire effort id that actually ran. `unknown` when the record carried none. */
    effort: string;
}
/** Aggregate stats for one classifier-verdict bucket (semantic tier). */
export interface TierStats extends BucketStats {
    tier: AutoTier;
}
/** The full report payload (Chinese strings live in `renderReport`). */
export interface EffortReport {
    /** Ledger dir the report priced against (for the "missing prices" hint). */
    ledgerDir: string;
    records: LedgerRecord[];
    /** Rows dropped because another row already claimed their `session:turn:step`. */
    replayRows: number;
    /**
     * Grouped by the wire effort that actually executed, lightest first. Dynamic
     * because the id space is model-specific: single-level models report only
     * `high`, five-level models add `highx`/`ultra`.
     */
    byEffort: EffortStats[];
    /**
     * Grouped by the classifier's own verdict, for comparison. A verdict is not
     * a run: a semantic `low` on a single-level model executes as `high`.
     */
    byTier: TierStats[];
    totalOutput: number;
    /** Estimated tokens saved by downshifting vs an always-heaviest baseline. */
    estimatedSaved: number;
    /** Estimated spend, priced row by row at report time. */
    cost: ReportCost;
    /** Lightest-level steps whose output ballooned beyond the high-level mean. */
    misroutesLowBallooned: LedgerRecord[];
    /** high-and-above steps whose output stayed tiny. */
    misroutesOverThought: LedgerRecord[];
}
/** Options for {@link buildReport}. */
export interface ReportOptions {
    /** `prices.json` text or the parsed object; wins over the built-in catalog. */
    priceOverrides?: string | Record<string, unknown>;
    /** Ledger dir to name in the "missing prices" hint. */
    ledgerDir?: string;
}
/** Aggregate ledger records into the report payload. */
export declare function buildReport(records: LedgerRecord[], options?: ReportOptions): EffortReport;
/** Render the report as a Chinese console block. */
export declare function renderReport(report: EffortReport): string;
