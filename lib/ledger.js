/**
 * Token ledger for dsh-effort-auto-toggle — the effort-router-style accounting
 * half: per-step JSONL records (tier + effort + usage), then a Chinese report
 * with per-tier usage, a downshift savings estimate, and misroute flags
 * (low-tier turns that ballooned, high/max turns that stayed tiny).
 *
 * Storage: one JSONL file per session under the ledger dir
 * (default `~/.dsh/effort-auto-toggle`); append-only, best-effort writes.
 */
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isAutoTier } from "./effort.js";
/** Default ledger root. */
export function defaultLedgerDir() {
    return join(homedir(), '.dsh', 'effort-auto-toggle');
}
/** Sanitize a session id into a filename-safe stem (no dots — no traversal). */
function fileStem(sessionId) {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/_+/g, '_').slice(0, 80);
    return safe.length > 0 ? safe : 'unknown';
}
/**
 * Append-only ledger sink. Best-effort: write failures are swallowed by the
 * caller-facing `append` (returns success) — accounting must never break the
 * request path.
 */
export class Ledger {
    dir;
    ready;
    constructor(dir = defaultLedgerDir()) {
        this.dir = dir;
    }
    /** Ledger file path for a session (exposed for tests/reporting). */
    pathFor(sessionId) {
        return join(this.dir, `ledger-${fileStem(sessionId)}.jsonl`);
    }
    /** Append one record; resolves false when the write failed. */
    async append(record) {
        try {
            this.ready ??= mkdir(this.dir, { recursive: true });
            await this.ready;
            await appendFile(this.pathFor(record.sessionId), `${JSON.stringify(record)}\n`, 'utf8');
            return true;
        }
        catch {
            this.ready = undefined;
            return false;
        }
    }
    /** Read every record of one session file (malformed lines skipped). */
    async read(sessionId) {
        return parseLedgerLines(await readFile(this.pathFor(sessionId), 'utf8').catch(() => ''));
    }
    /** List available session ids (files present in the ledger dir). */
    async sessions() {
        try {
            this.ready ??= mkdir(this.dir, { recursive: true });
            await this.ready;
            const names = await readdir(this.dir);
            return names
                .filter(name => name.startsWith('ledger-') && name.endsWith('.jsonl'))
                .map(name => name.slice('ledger-'.length, -'.jsonl'.length))
                .sort();
        }
        catch {
            return [];
        }
    }
}
/** Parse JSONL text into records, skipping malformed lines. */
export function parseLedgerLines(text) {
    const records = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0)
            continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (!isLedgerRecord(parsed))
                continue;
            records.push(normalizeRecord(parsed));
        }
        catch {
            // skip malformed line
        }
    }
    return records;
}
function isLedgerRecord(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const tier = value.tier;
    return isAutoTier(tier);
}
function normalizeRecord(value) {
    const tier = value.tier;
    return {
        ts: str(value.ts),
        sessionId: str(value.sessionId),
        turn: num(value.turn),
        step: num(value.step),
        model: str(value.model),
        provider: str(value.provider),
        tier,
        effort: str(value.effort),
        reason: str(value.reason),
        classifierSource: str(value.classifierSource),
        classifierScore: num(value.classifierScore),
        inputTokens: num(value.inputTokens),
        outputTokens: num(value.outputTokens),
    };
}
function str(value) {
    return typeof value === 'string' ? value : '';
}
function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
/** Aggregate ledger records into the report payload. */
export function buildReport(records) {
    const tiers = ['low', 'high', 'max'];
    const byTier = tiers.map(tier => {
        const subset = records.filter(record => record.effort === tier);
        const outputTokens = subset.reduce((sum, record) => sum + record.outputTokens, 0);
        return {
            tier,
            steps: subset.length,
            outputTokens,
            meanOutput: subset.length > 0 ? Math.round(outputTokens / subset.length) : 0,
        };
    });
    const totalOutput = byTier.reduce((sum, stats) => sum + stats.outputTokens, 0);
    // Savings estimate (effort-router style): what would the low/max-heavy mix
    // have cost if every step ran at the max-tier mean? Use the overall mean
    // when a tier has no samples. Thinking tokens dominate cost differences, so
    // this is a rough counterfactual, not a bill.
    const overallMean = records.length > 0 ? Math.round(totalOutput / records.length) : 0;
    const maxMean = byTier.find(stats => stats.tier === 'max')?.meanOutput || overallMean;
    const downshifted = byTier
        .filter(stats => stats.tier !== 'max')
        .reduce((sum, stats) => sum + stats.steps, 0);
    const estimatedSaved = Math.max(0, downshifted * (maxMean - overallMean));
    const highMean = byTier.find(stats => stats.tier === 'high')?.meanOutput || overallMean;
    const misroutesLowBallooned = records.filter(record => record.effort === 'low' && record.outputTokens > 2 * Math.max(1, highMean));
    const misroutesOverThought = records.filter(record => (record.effort === 'high' || record.effort === 'max') && record.outputTokens > 0
        && record.outputTokens < 200);
    return { records, byTier, totalOutput, estimatedSaved, misroutesLowBallooned, misroutesOverThought };
}
/** Render the report as a Chinese console block. */
export function renderReport(report) {
    const { byTier, totalOutput, estimatedSaved, misroutesLowBallooned, misroutesOverThought } = report;
    const lines = [];
    lines.push('== 自适应思考档位报表 ==');
    lines.push(`会话步骤数：${report.records.length}，总输出 tokens：${totalOutput}`);
    lines.push('');
    lines.push('档位      步数    输出 tokens    均值/步');
    for (const stats of byTier) {
        lines.push(`${stats.tier.padEnd(8)}  ${String(stats.steps).padEnd(6)}  ${String(stats.outputTokens).padEnd(12)}  ${stats.meanOutput}`);
    }
    lines.push('');
    lines.push(`降档节省估算（相对全程 max 的粗略反事实）：约 ${estimatedSaved} tokens`);
    if (misroutesLowBallooned.length > 0) {
        lines.push('');
        lines.push('疑似低估（low 档但输出爆炸，>2× high 档均值）：');
        for (const record of misroutesLowBallooned.slice(0, 10)) {
            lines.push(`  turn ${record.turn} step ${record.step}  ${record.outputTokens} tokens  ${record.reason}`);
        }
    }
    if (misroutesOverThought.length > 0) {
        lines.push('');
        lines.push('疑似高估（high/max 档但输出极小 <200 tokens）：');
        for (const record of misroutesOverThought.slice(0, 10)) {
            lines.push(`  turn ${record.turn} step ${record.step}  ${record.outputTokens} tokens  ${record.reason}`);
        }
    }
    if (misroutesLowBallooned.length === 0 && misroutesOverThought.length === 0) {
        lines.push('无误路由标记。');
    }
    return lines.join('\n');
}
