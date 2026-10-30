/**
 * Token ledger for dsh-effort-auto-toggle — the effort-router-style accounting
 * half: per-step JSONL records (tier + effort + usage), then a Chinese report
 * with per-tier usage, a downshift savings estimate, and misroute flags
 * (low-tier turns that ballooned, high/max turns that stayed tiny).
 *
 * Storage: one JSONL file per session under the ledger dir
 * (default `~/.dsh/effort-auto-toggle`); append-only, best-effort writes.
 */
import type { AutoTier } from './effort.ts';
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
    inputTokens: number;
    outputTokens: number;
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
    /** Append one record; resolves false when the write failed. */
    append(record: LedgerRecord): Promise<boolean>;
    /** Read every record of one session file (malformed lines skipped). */
    read(sessionId: string): Promise<LedgerRecord[]>;
    /** List available session ids (files present in the ledger dir). */
    sessions(): Promise<string[]>;
}
/** Parse JSONL text into records, skipping malformed lines. */
export declare function parseLedgerLines(text: string): LedgerRecord[];
/** Aggregate stats for one tier bucket. */
export interface TierStats {
    tier: AutoTier;
    steps: number;
    outputTokens: number;
    meanOutput: number;
}
/** The full report payload (Chinese strings live in `renderReport`). */
export interface EffortReport {
    records: LedgerRecord[];
    byTier: TierStats[];
    totalOutput: number;
    /** Estimated tokens saved by downshifting vs a max-everything baseline. */
    estimatedSaved: number;
    /** Downshifted steps whose output ballooned beyond the high-tier mean. */
    misroutesLowBallooned: LedgerRecord[];
    /** high/max steps whose output stayed tiny. */
    misroutesOverThought: LedgerRecord[];
}
/** Aggregate ledger records into the report payload. */
export declare function buildReport(records: LedgerRecord[]): EffortReport;
/** Render the report as a Chinese console block. */
export declare function renderReport(report: EffortReport): string;
