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
    /**
     * Serialises the fire-and-forget appends.
     *
     * Callers never await the ledger (accounting must not slow a turn down), so
     * several rows can be in flight at once: a live session/event row for step
     * 2 racing the agent/request catch-up sweep that emitted steps 1..2. Two
     * independent `appendFile` calls do not preserve call order, so the JSONL
     * came out shuffled and `report --last` would read a session out of order.
     * Chaining keeps the file chronological without making any caller wait.
     */
    queue = Promise.resolve();
    constructor(dir = defaultLedgerDir()) {
        this.dir = dir;
    }
    /** Ledger file path for a session (exposed for tests/reporting). */
    pathFor(sessionId) {
        return join(this.dir, `ledger-${fileStem(sessionId)}.jsonl`);
    }
    /** Append one record; resolves false when the write failed. */
    append(record) {
        const line = `${JSON.stringify(record)}\n`;
        this.queue = this.queue.then(async () => {
            try {
                this.ready ??= mkdir(this.dir, { recursive: true });
                await this.ready;
                await appendFile(this.pathFor(record.sessionId), line, 'utf8');
                return true;
            }
            catch {
                this.ready = undefined;
                return false;
            }
        });
        return this.queue;
    }
    /**
     * Every key already present on disk, as `${sessionId}|${turn}:${step}`.
     *
     * Read once at startup so a restored process can tell a row it is about to
     * write from one it wrote in a previous life. Best-effort: an unreadable
     * directory yields an empty set and dedupe degrades to per-process, which is
     * exactly what it was before 0.3.5.
     */
    async existingKeys() {
        const keys = new Set();
        for (const sessionId of await this.sessions()) {
            let text;
            try {
                text = await readFile(this.pathFor(sessionId), 'utf8');
            }
            catch {
                continue;
            }
            for (const line of text.split('\n')) {
                const trimmed = line.trim();
                if (trimmed.length === 0)
                    continue;
                try {
                    const parsed = JSON.parse(trimmed);
                    if (typeof parsed !== 'object' || parsed === null)
                        continue;
                    const turn = typeof parsed.turn === 'number' ? parsed.turn : 0;
                    const step = typeof parsed.step === 'number' ? parsed.step : 0;
                    const sid = typeof parsed.sessionId === 'string' && parsed.sessionId !== '' ? parsed.sessionId : sessionId;
                    keys.add(`${sid}|${turn}:${step}`);
                }
                catch {
                    // skip malformed line
                }
            }
        }
        return keys;
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
        cacheReadTokens: num(value.cacheReadTokens),
        cacheWriteTokens: num(value.cacheWriteTokens),
    };
}
function str(value) {
    return typeof value === 'string' ? value : '';
}
function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
/**
 * Known wire levels, lightest first. Models that publish more levels land
 * between these (a 5-level model reports low/high/highx/max/ultra); unknown
 * ids sort last so nothing is ever dropped from the report.
 */
const EFFORT_RANK = ['minimal', 'low', 'medium', 'high', 'highx', 'max', 'ultra'];
function rankOf(effort) {
    const index = EFFORT_RANK.indexOf(effort);
    if (index !== -1)
        return index;
    // Legacy rows (0.2.x wrote `medium`; toggle-only routes wrote `on`) and any
    // future id we have never seen. Ranking an unknown id at the TOP made it the
    // savings ceiling and inflated the estimate, so assume the middle instead.
    return EFFORT_RANK.indexOf('high');
}
/** Token totals for one bucket. */
function totals(subset, key, tier) {
    const outputTokens = subset.reduce((sum, record) => sum + record.outputTokens, 0);
    const inputTokens = subset.reduce((sum, record) => sum + record.inputTokens, 0);
    const cacheReadTokens = subset.reduce((sum, record) => sum + record.cacheReadTokens, 0);
    return {
        [key]: tier,
        steps: subset.length,
        outputTokens,
        inputTokens,
        cacheReadTokens,
        meanOutput: subset.length > 0 ? Math.round(outputTokens / subset.length) : 0,
    };
}
/**
 * Aggregate ledger records into the report payload.
 *
 * Token accounting buckets by the wire effort that actually ran — dynamically,
 * because the id space is model-specific (`highx`/`ultra` on five-level models,
 * a lone `high` on single-level ones) and a hardcoded low/high/max list silently
 * dropped every other row. The classifier's own verdict is reported separately
 * as `byTier`, since a verdict is not a run: a semantic `low` on a model with
 * only one level executes as `high`.
 */
export function buildReport(input) {
    // 0.3.4 could write the same step twice across a restart (the whole event log
    // was replayed into the file). 0.3.5 stops producing them, but the files on
    // disk still carry them, so the report folds duplicates by session:turn:step
    // and reports how many it dropped instead of quietly double counting.
    const seen = new Set();
    const records = [];
    for (const record of input) {
        const key = `${record.sessionId}|${record.turn}:${record.step}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        records.push(record);
    }
    const replayRows = input.length - records.length;
    const effortKeys = [...new Set(records.map(record => (record.effort === '' ? 'unknown' : record.effort)))];
    effortKeys.sort((a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b));
    const byEffort = effortKeys.map(effort => totals(
        records.filter(record => (record.effort === '' ? 'unknown' : record.effort) === effort),
        'effort',
        effort,
    ));
    const byTier = ['low', 'high', 'max'].map(tier => totals(
        records.filter(record => record.tier === tier),
        'tier',
        tier,
    ));
    const totalOutput = records.reduce((sum, record) => sum + record.outputTokens, 0);
    // Savings estimate (effort-router style): what would this mix have cost if
    // every step ran at the heaviest observed level's mean? Use the overall mean
    // when the heaviest bucket has no samples. Thinking tokens dominate cost
    // differences, so this is a rough counterfactual, not a bill.
    const overallMean = records.length > 0 ? Math.round(totalOutput / records.length) : 0;
    // The counterfactual baseline is the costliest observed per-step mean, not
    // the heaviest level's mean: on real data the heaviest bucket is often made
    // of short steps (a max-level step that answers in one line), so keying the
    // baseline to it understates the gap and zeroes the estimate out.
    const ceilingMean = byEffort.reduce((best, stats) => Math.max(best, stats.meanOutput), 0) || overallMean;
    // Counterfactual total minus the actual total: what the same number of steps
    // would have cost if every one of them had come in at that ceiling mean.
    const estimatedSaved = Math.max(0, records.length * ceilingMean - totalOutput);
    const highStats = byEffort.find(stats => stats.effort === 'high');
    const highMean = highStats && highStats.meanOutput > 0 ? highStats.meanOutput : overallMean;
    const lightest = byEffort.length > 0 ? byEffort[0].effort : 'low';
    const misroutesLowBallooned = records.filter(record => (record.effort === '' ? 'unknown' : record.effort) === lightest
        && record.outputTokens > 2 * Math.max(1, highMean));
    const misroutesOverThought = records.filter(record => rankOf(record.effort) >= rankOf('high') && record.outputTokens > 0
        && record.outputTokens < 200);
    return { records, replayRows, byEffort, byTier, totalOutput, estimatedSaved, misroutesLowBallooned, misroutesOverThought };
}
/** Render the report as a Chinese console block. */
export function renderReport(report) {
    const { byEffort, byTier, totalOutput, estimatedSaved, replayRows, misroutesLowBallooned, misroutesOverThought } = report;
    const lightest = byEffort.length > 0 ? byEffort[0].effort : 'low';
    const lines = [];
    lines.push('== 自适应思考档位报表 ==');
    lines.push(`会话步骤数：${report.records.length}${replayRows > 0 ? `（已剔除重放重复行 ${replayRows}）` : ''}，总输出 tokens：${totalOutput}`);
    lines.push('');
    lines.push('实际档位  步数    输出 tokens    均值/步    输入(未缓存)  缓存读');
    for (const stats of byEffort) {
        lines.push(`${stats.effort.padEnd(9)} ${String(stats.steps).padEnd(6)}  ${String(stats.outputTokens).padEnd(12)}  ${String(stats.meanOutput).padEnd(9)}  ${String(stats.inputTokens).padEnd(12)}  ${stats.cacheReadTokens}`);
    }
    lines.push('');
    lines.push('分类器判定  步数    输出 tokens    均值/步');
    for (const stats of byTier) {
        lines.push(`${stats.tier.padEnd(10)}  ${String(stats.steps).padEnd(6)}  ${String(stats.outputTokens).padEnd(12)}  ${stats.meanOutput}`);
    }
    lines.push('');
    lines.push(`降档节省估算（同一步数全部按最贵档均值的粗略反事实）：约 ${estimatedSaved} tokens`);
    if (misroutesLowBallooned.length > 0) {
        lines.push('');
        lines.push(`疑似低估（${lightest} 档但输出爆炸，>2× high 档均值）：`);
        for (const record of misroutesLowBallooned.slice(0, 10)) {
            lines.push(`  turn ${record.turn} step ${record.step}  ${record.outputTokens} tokens  ${record.reason}`);
        }
    }
    if (misroutesOverThought.length > 0) {
        lines.push('');
        lines.push('疑似高估（high 及更重档但输出极小 <200 tokens）：');
        for (const record of misroutesOverThought.slice(0, 10)) {
            lines.push(`  turn ${record.turn} step ${record.step}  ${record.outputTokens} tokens  ${record.reason}`);
        }
    }
    if (misroutesLowBallooned.length === 0 && misroutesOverThought.length === 0) {
        lines.push('无误路由标记。');
    }
    return lines.join('\n');
}
