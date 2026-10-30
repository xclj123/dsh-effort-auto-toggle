/**
 * Complexity classifier for dsh-effort-auto-toggle.
 *
 * Two backends, mirroring hermes-plugin-effort-auto-toggle's tier design
 * (score each user message -> low / high / max) but with a MiniMax LLM as the
 * primary scorer instead of local embeddings:
 *
 * 1. `minimax`  — a chat-completions call with thinking disabled (the only
 *                 reliable way per MiniMax docs: `thinking: {type:"disabled"}`),
 *                 tiny max_tokens, strict JSON out. Fast, cheap, no local model.
 * 2. `heuristic` — zero-dependency fallback (also used on timeout / HTTP /
 *                 parse failure / missing key): length + code blocks + heavy
 *                 keywords + question pressure.
 *
 * Pure inputs -> output; the fetch is injected so tests can stub it.
 */
import { assertAutoTier } from "./effort.js";
/** System prompt for the scorer: short, deterministic, JSON-only. */
const SCORER_SYSTEM_PROMPT = [
    '你是编码助手的任务复杂度评分器。给定用户消息（可能附带会话工具活动摘要），',
    '评估下一轮模型响应所需的推理深度。只输出 JSON，不要输出其他内容：',
    '{"score": 0-100, "tier": "low"|"high"|"max"}',
    '标准：low=闲聊/简单问答/小改动/格式化（score<35）；',
    'high=明确范围的功能开发/常规调试/文档（35<=score<70）；',
    'max=多文件重构/架构设计/疑难bug/并发/安全/长程agent任务（score>=70）。',
].join('');
/** How much of the user text the scorer sees (chars; keep the call cheap). */
const SCORER_TEXT_LIMIT = 4000;
/** Heavy-work keywords for the heuristic backend (word-ish boundaries). */
const HEAVY_KEYWORDS = [
    '重构', 'refactor', '架构', 'architecture', '并发', 'concurren', '死锁', 'deadlock',
    '竞态', 'race', '调试', 'debug', '排查', 'diagnos', '优化', 'optimiz', '性能', 'perf',
    '迁移', 'migrat', '安全', 'security', '漏洞', 'vulnerab', '加密', 'crypto',
    '端到端', 'e2e', '测试套件', 'test suite', '多文件', 'multi-file', '全仓', '仓库', 'monorepo',
    'agent', 'workflow', 'pipeline', '基准', 'benchmark',
];
/** Simple-work signals (push the score down). */
const SIMPLE_KEYWORDS = [
    '谢谢', 'thanks', '你好', 'hello', '继续', 'continue', '好的', 'ok',
    '格式化', 'format', '改名', 'rename', '拼写', 'typo', '总结一下', 'summarize',
];
/**
 * Extract the first JSON object from a string (scorers sometimes wrap JSON
 * in prose or fences despite instructions).
 */
export function extractJson(raw) {
    const start = raw.indexOf('{');
    if (start < 0)
        return undefined;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i += 1) {
        const ch = raw[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            if (inString)
                escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString)
            continue;
        if (ch === '{')
            depth += 1;
        if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                try {
                    const parsed = JSON.parse(raw.slice(start, i + 1));
                    if (typeof parsed === 'object' && parsed !== null)
                        return parsed;
                }
                catch {
                    return undefined;
                }
            }
        }
    }
    return undefined;
}
/** Map a 0-100 score to the three auto tiers. */
export function scoreToTier(score) {
    if (score < 35)
        return 'low';
    if (score < 70)
        return 'high';
    return 'max';
}
/**
 * Zero-dependency heuristic score for a user message.
 *
 * Signals: length, fenced code blocks, heavy/simple keywords, question marks,
 * attached file count (@-mentions). Deterministic; unit-testable.
 */
export function heuristicScore(text) {
    if (text.trim().length === 0)
        return 5;
    let score = Math.min(30, Math.round(text.length / 160));
    const fences = (text.match(/```/g) ?? []).length;
    score += Math.min(24, Math.floor(fences / 2) * 12);
    const lower = text.toLowerCase();
    let heavyCount = 0;
    for (const keyword of HEAVY_KEYWORDS) {
        if (lower.includes(keyword))
            heavyCount += 1;
    }
    // A single heavy keyword nudges; several stacked heavy signals are
    // themselves strong evidence of heavy work, independent of length.
    score += Math.min(24, heavyCount * 12);
    if (heavyCount >= 4)
        score = Math.max(score, 76);
    else if (heavyCount >= 3)
        score = Math.max(score, 70);
    else if (heavyCount >= 2)
        score = Math.max(score, 60);
    for (const keyword of SIMPLE_KEYWORDS) {
        if (lower.includes(keyword))
            score -= 6;
    }
    const questions = (text.match(/[?？]/g) ?? []).length;
    score += Math.min(9, questions * 3);
    const files = (text.match(/@[^\s@]{1,60}/g) ?? []).length;
    score += Math.min(9, files * 3);
    return Math.max(0, Math.min(100, score));
}
/** The heuristic result on its own (fallback path). */
export function heuristicClassify(text, note) {
    const score = heuristicScore(text);
    return { tier: scoreToTier(score), score, source: 'heuristic', note };
}
function readEnvKey() {
    return process.env.MINIMAX_API_KEY ?? '';
}
/**
 * Classify one user message with the MiniMax backend.
 *
 * Never throws: any failure (missing key, timeout, HTTP error, unparsable
 * body) degrades to the heuristic result with a note. Thinking is disabled on
 * the scorer call (`thinking: {type:"disabled"}`) — the documented MiniMax
 * switch — because scoring must stay fast and cheap.
 *
 * @param text - the user message to score.
 * @param options - resolved MiniMax settings.
 * @param fetchImpl - fetch to use (injectable for tests).
 */
export async function minimaxClassify(text, options, fetchImpl = fetch) {
    const apiKey = options.apiKey || readEnvKey();
    if (!apiKey)
        return heuristicClassify(text, '未配置 MINIMAX_API_KEY，回退启发式');
    const truncated = text.length > SCORER_TEXT_LIMIT
        ? `${text.slice(0, SCORER_TEXT_LIMIT)}…[截断]`
        : text;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(250, options.timeoutMs));
    try {
        const response = await fetchImpl(`${options.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: options.model,
                messages: [
                    { role: 'system', content: SCORER_SYSTEM_PROMPT },
                    { role: 'user', content: truncated },
                ],
                thinking: { type: 'disabled' },
                max_tokens: 128,
                temperature: 0,
            }),
            signal: controller.signal,
        });
        if (!response.ok) {
            return heuristicClassify(text, `MiniMax HTTP ${response.status}，回退启发式`);
        }
        const body = await response.json();
        const content = readFirstChoiceContent(body);
        if (content === undefined)
            return heuristicClassify(text, 'MiniMax 响应缺少 content，回退启发式');
        const parsed = extractJson(content);
        const tier = parsed?.tier;
        const scoreValue = parsed?.score;
        if (!isTierString(tier))
            return heuristicClassify(text, 'MiniMax 输出无合法 tier，回退启发式');
        assertAutoTier(tier, 'dsh-effort-auto-toggle minimax tier');
        const score = typeof scoreValue === 'number' && Number.isFinite(scoreValue)
            ? Math.max(0, Math.min(100, scoreValue))
            : 0;
        const fusedH = heuristicClassify(text, 'GLM+heuristic 融合取高');
        return fusedH.score > score
            ? { tier: fusedH.tier, score: fusedH.score, source: 'minimax+heuristic' }
            : { tier, score, source: 'minimax' };
    }
    catch (error) {
        const reason = error instanceof Error && error.name === 'AbortError'
            ? `MiniMax 超时（${options.timeoutMs}ms），回退启发式`
            : `MiniMax 调用失败（${error instanceof Error ? error.message : String(error)}），回退启发式`;
        return heuristicClassify(text, reason);
    }
    finally {
        clearTimeout(timer);
    }
}
function isTierString(value) {
    return value === 'low' || value === 'high' || value === 'max';
}
function readFirstChoiceContent(body) {
    if (typeof body !== 'object' || body === null)
        return undefined;
    const choices = body.choices;
    if (!Array.isArray(choices) || choices.length === 0)
        return undefined;
    const first = choices[0];
    if (typeof first !== 'object' || first === null)
        return undefined;
    const message = first.message;
    if (typeof message !== 'object' || message === null)
        return undefined;
    const content = message.content;
    return typeof content === 'string' ? content : undefined;
}
