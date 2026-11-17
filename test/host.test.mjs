/**
 * Offline host-half tests for dsh-effort-auto-toggle.
 *
 * No DSH process, no network, no live profile: `apply()` is driven through a
 * fake cordis context, so the exact wiring cordis uses (ctx.on / ctx.inject /
 * settings scope) is exercised without touching the running app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { apply, DEFAULT_CONFIG , statsSummaryOf} from '../lib/index.js';

const AUTO = 'auto';
const WIRE = ['off', 'low', 'high', 'max'];

function harness(overrides = {}, efforts = [{ id: 'low' }, { id: 'high' }, { id: 'max' }], opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'effort-toggle-'));
  const store = { ...DEFAULT_CONFIG, mode: 'heuristic', ledgerDir: dir, ...overrides };
  const handlers = new Map();
  // 0.2.3: simulate a host 0.2.2+ agent carrying the model selection API.
  const modern = opts.modern === true;
  const selectCalls = [];
  const selection = { provider: 'bigmodel', model: 'glm-5.3-3-step', reasoningEffort: 'max' };
  const logs = { info: [], warn: [] };
  const listeners = new Set();
  const scope = {
    get: () => store,
    set: (key, value) => { store[key] = value; for (const l of listeners) l(); },
    unset: (key) => { delete store[key]; for (const l of listeners) l(); },
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
    getSnapshot: () => ({ status: 'ok', writable: true, value: store }),
    watch: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  };
  const ctx = {
    logger: {
      info: (msg, ...args) => logs.info.push(format(msg, ...args)),
      warn: (msg, ...args) => logs.warn.push(format(msg, ...args)),
    },
    on: (name, cb, opts) => { handlers.set(name, { cb, opts }); return () => handlers.delete(name); },
    inject: (deps, fn) => {
      if (deps.includes('llm'))
        fn({ llm: { resolveModelInfo: async () => ({ provider: 'bigmodel', id: 'glm-5.3-' + efforts.length + '-step', reasoning: { efforts } }) } });
      if (deps.includes('settings'))
        fn({
          settings: {
            describe: () => [{ ns: 'dsh-effort-auto-toggle', value: { ...store } }],
            update: (ns, patch) => { Object.assign(store, patch); },
          },
          effect: (f) => { f(); return () => {}; },
        });
    },
    effect: (fn) => fn(),
    get: () => undefined,
  };
  apply(ctx, store);
  const modelApi = modern
    ? {
        current: () => ({ ...selection }),
        select: (s) => { selectCalls.push({ ...s }); Object.assign(selection, s); },
      }
    : null;
  // dsh 0.2.2-rc.3 Session has no `events` getter — it exposes a snapshot
  // reader instead. The default mock mirrors the CURRENT host; pass
  // `legacySession: true` to exercise the pre-rc.3 array shape.
  const agentOf = (events = []) => {
    const session = opts.legacySession
      ? { id: 'sess-1', events }
      : { id: 'sess-1', seq: events.length, snapshotEvents: () => events, ownEvents: () => events };
    return { session, ...(modelApi ? { model: modelApi } : {}) };
  };
  const request = (seed, events = [], turn = 1, step = 1) =>
    handlers.get('agent/request').cb(
      { turn, step, agent: agentOf(events) },
      async () => ({ provider: 'bigmodel', model: 'glm-5.3-' + efforts.length + '-step', ...seed }),
    );
  const claim = (text, turn = 1) =>
    handlers.get('agent/inbox/claimed').cb({ message: { role: 'user', content: [{ type: 'text', text }] }, turn, agent: agentOf() });
  const broadcast = (session, event) => handlers.get('session/event').cb(session, event);
  // 0.2.7: the toggle's source of truth is back to the settings value (the
  // client writes through the remote.settings RPC); arm() flips the store.
  const arm = (on) => { store.autoOn = on; };
  return { dir, logs, request, claim, store, broadcast, selection, selectCalls, arm, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const userMsg = (text) => ({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }] } });

test('defaults: auto is off, so the plugin is inert until the button is pressed', () => {
  assert.equal(DEFAULT_CONFIG.autoOn, false);
  assert.equal(DEFAULT_CONFIG.enabled, true);
});

test('passthrough: a leftover "auto" never reaches the provider (the UNSUPPORTED_REASONING_EFFORT bug)', async () => {
  const h = harness();
  try {
    const out = await h.request({ reasoningEffort: AUTO });
    assert.equal(out.reasoningEffort, 'high');
    assert.ok(h.logs.warn.some((l) => l.includes('not accepted by the provider')), 'expected a sanitise warning');
  } finally { h.cleanup(); }
});

test('passthrough: a plain manual pick is returned untouched (same object)', async () => {
  const h = harness();
  try {
    const out = await h.request({ reasoningEffort: 'max' });
    assert.equal(out.reasoningEffort, 'max');
    assert.ok(!h.logs.info.some((l) => l.includes('->')), 'no override should be logged');
  } finally { h.cleanup(); }
});

test('passthrough: unsupported "medium" and an unset effort are handled', async () => {
  const h = harness();
  try {
    assert.equal((await h.request({ reasoningEffort: 'medium' })).reasoningEffort, 'high');
    const unset = await h.request({ reasoningEffort: undefined });
    assert.equal(unset.reasoningEffort, undefined, 'no selection on the wire means no override');
  } finally { h.cleanup(); }
});

test('passthrough: manual "off" on a forced-thinking model is clamped to low', async () => {
  const h = harness();
  try {
    const out = await h.request({ reasoningEffort: 'off' });
    assert.equal(out.reasoningEffort, 'low');
  } finally { h.cleanup(); }
});

test('armed: every scheduled effort is a real wire tier, never auto/off/medium', async () => {
  const h = harness();
  try {
    h.arm(true);
    for (const text of ['hi', 'refactor the whole scheduler and add tests for every branch', '跑一下测试']) {
      const out = await h.request({ reasoningEffort: AUTO }, [userMsg(text)]);
      assert.ok(WIRE.includes(out.reasoningEffort), `bad tier ${out.reasoningEffort}`);
      assert.notEqual(out.reasoningEffort, 'off');
      assert.notEqual(out.reasoningEffort, 'medium');
    }
    assert.ok(h.logs.info.some((l) => l.includes('=> effort=')), 'armed requests must go through the scheduler, not the sanitiser');
  } finally { h.cleanup(); }
});

test('disarm: the first request after the button goes dark restores the pre-auto manual effort', async () => {
  const h = harness();
  try {
    h.arm(true);
    const armed = await h.request({ reasoningEffort: 'max' }, [userMsg('hi')]);
    h.arm(false);
    const restored = await h.request({ reasoningEffort: armed.reasoningEffort }, [userMsg('hi')]);
    assert.equal(restored.reasoningEffort, 'max');
    const after = await h.request({ reasoningEffort: 'low' }, [userMsg('hi')]);
    assert.equal(after.reasoningEffort, 'low', 'once restored, the native picker rules again');
  } finally { h.cleanup(); }
});

test('disabled: config.enabled=false skips everything', async () => {
  const h = harness({ enabled: false });
  try {
    const out = await h.request({ reasoningEffort: AUTO });
    assert.equal(out.reasoningEffort, AUTO, 'a disabled plugin must not rewrite the effort');
  } finally { h.cleanup(); }
});

test("continuity is session-scoped: another session recent tool calls do not pin a fresh low message", async () => {
  const h = harness();
  try {
    h.arm(true);
    h.broadcast({ id: 'sess-other' }, { type: 'tool/call', data: { name: 'bash', arguments: 'x'.repeat(1290) } });
    const out = await h.request({ reasoningEffort: AUTO }, [userMsg('你好')]);
    assert.equal(out.reasoningEffort, 'low');
  } finally { h.cleanup(); }
});

test('continuity still pins low within the same session after recent tool activity', async () => {
  const h = harness();
  try {
    h.arm(true);
    h.broadcast({ id: 'sess-1' }, { type: 'tool/call', data: { name: 'bash', arguments: 'x'.repeat(900) } });
    const out = await h.request({ reasoningEffort: AUTO }, [userMsg('你好')]);
    assert.equal(out.reasoningEffort, 'high');
  } finally { h.cleanup(); }
});

// ---- 0.2.0 model-adaptive ladders ----
test('ladder mapping: semantic tiers land on the real levels of each model', async () => {
  const { buildLadder, semanticToLadder, guessSemantic, DEFAULT_LADDER } = await import('../lib/effort.js');
  // 5-level ladder: low,high,highx,max,ultra
  const five = buildLadder([{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'highx' }, { id: 'max' }, { id: 'ultra' }]);
  assert.deepEqual(five, ['low', 'high', 'highx', 'max', 'ultra']);
  assert.equal(semanticToLadder('low', five), 'low');
  assert.equal(semanticToLadder('high', five), 'highx');
  assert.equal(semanticToLadder('max', five), 'ultra');
  // classic 3-level: identity
  const three = buildLadder([{ id: 'low' }, { id: 'high' }, { id: 'max' }]);
  assert.equal(semanticToLadder('high', three), 'high');
  assert.equal(semanticToLadder('max', three), 'max');
  // 2-level collapse
  const two = ['low', 'high'];
  assert.equal(semanticToLadder('high', two), 'high');
  assert.equal(semanticToLadder('max', two), 'high');
  // degenerate input falls back to the default ladder
  assert.deepEqual(buildLadder(undefined), DEFAULT_LADDER);
  assert.deepEqual(buildLadder([]), DEFAULT_LADDER);
  // reverse mapping for the ledger
  assert.equal(guessSemantic('ultra', five), 'max');
  assert.equal(guessSemantic('highx', five), 'high');
  assert.equal(guessSemantic('low', five), 'low');
  assert.equal(guessSemantic('weird', five), 'high');
});

test('armed on a 5-level model: the scheduler emits real levels (ultra/heighx), never phantom ones', async () => {
  const five = [{ id: 'low' }, { id: 'high' }, { id: 'highx' }, { id: 'max' }, { id: 'ultra' }];
  const h = harness({}, five);
  try {
    h.arm(true);
    // three heavy keywords (refactor+debug+race) -> heuristic high -> highx
    const out = await h.request({ reasoningEffort: AUTO }, [userMsg('refactor the debug flow and fix it:\n```\nsome code\n```\nand keep the tail explicit')]);
    assert.equal(out.reasoningEffort, 'highx');
    // five stacked heavy signals -> heuristic max -> the heaviest real level
    const heavy = await h.request({ reasoningEffort: AUTO }, [userMsg('refactor the scheduler architecture, debug the race, optimiz perf')]);
    assert.equal(heavy.reasoningEffort, 'ultra');
    // idle chatter -> low stays the lightest real level
    const out2 = await h.request({ reasoningEffort: AUTO }, [userMsg('hi')]);
    assert.equal(out2.reasoningEffort, 'low');
  } finally { h.cleanup(); }
});

// ---- 0.2.3 host 0.2.2+ path: agent.model.select instead of request rewrite ----
// The host validates the waterfall result against the step's fixed selection
// (provider/model/reasoningEffort must be untouched); this mirrors that check.
function loopValidate(out, selection) {
  if (out.provider !== selection.provider || out.model !== selection.model)
    throw new Error('proposed model differs from the step selection');
  if (out.reasoningEffort !== selection.reasoningEffort)
    throw new Error('proposed effort differs from the step selection: use agent.model.select() before step preparation');
}

test('modern claimed: a simple message selects low at claim time; the request stays read-only', async () => {
  const h = harness({}, undefined, { modern: true });
  try {
    h.arm(true);
    h.claim('hi');
    assert.ok(h.selectCalls.some((s) => s.reasoningEffort === 'low'), 'claim must select low via agent.model.select');
    const sel = { ...h.selection };
    const out = await h.request({ reasoningEffort: sel.reasoningEffort });
    loopValidate(out, sel);
  } finally { h.cleanup(); }
});

test('modern request: an unclaimed turn queues the desired effort for the next step and never rewrites this one', async () => {
  const h = harness({}, undefined, { modern: true });
  try {
    h.arm(true);
    const sel = { ...h.selection }; // adapter default max
    const out = await h.request({ reasoningEffort: 'max' }, [userMsg('hi')]); // desired low, wire max
    loopValidate(out, sel);
    assert.ok(h.selectCalls.some((s) => s.reasoningEffort === 'low'), 'the desired effort must be queued via select()');
  } finally { h.cleanup(); }
});

test('0.3.3 continuity: a heavy tool call lifts a low verdict exactly one rung, never to max', async () => {
  const h = harness({}, undefined, { modern: true });
  try {
    h.arm(true);
    // A five-level model: max is a real level, so a self-bootstrapping rule would
    // be free to reach it. One continuity lift must still land on `high`.
    h.broadcast({ id: 'sess-1' }, { type: 'tool/call', data: { name: 'bash', arguments: 'x'.repeat(900) } });
    h.claim('你好');
    const efforts = h.selectCalls.map((s) => s.reasoningEffort);
    assert.ok(efforts.includes('high'), 'continuity must lift low to high');
    assert.ok(!efforts.includes('max'), `continuity must never escalate straight to max, saw ${JSON.stringify(efforts)}`);
  } finally { h.cleanup(); }
});

test('modern continuity: recent tool activity in the session pins the claim-time low up to high', async () => {
  const h = harness({}, undefined, { modern: true });
  try {
    h.arm(true);
    h.broadcast({ id: 'sess-1' }, { type: 'tool/call', data: { name: 'bash', arguments: 'x'.repeat(900) } });
    h.claim('你好');
    assert.ok(h.selectCalls.some((s) => s.reasoningEffort === 'high'), 'continuity must bump the claim-time selection');
  } finally { h.cleanup(); }
});

test('modern disarm: the first passthrough after going dark restores the pre-auto manual pick via select()', async () => {
  const h = harness({}, undefined, { modern: true });
  try {
    h.arm(true);
    await h.request({ reasoningEffort: 'max' }, [userMsg('hi')]); // arms; pre-auto wire was max; queues low
    const armedCalls = h.selectCalls.length;
    h.arm(false);
    const sel = { ...h.selection }; // low (our queued select)
    const out = await h.request({ reasoningEffort: 'low' }); // passthrough
    loopValidate(out, sel);
    assert.ok(h.selectCalls.slice(armedCalls).some((s) => s.reasoningEffort === 'max'), 'disarm must restore the pre-auto manual effort');
  } finally { h.cleanup(); }
});

test('modern disarmed claim: manual off on a forced-thinking model is clamped to low once the ladder is cached', async () => {
  const h = harness({}, undefined, { modern: true });
  try {
    h.arm(true);
    await h.request({ reasoningEffort: 'max' }, [userMsg('hi')]); // fills ladderCache via the llm service
    h.arm(false);
    h.selection.reasoningEffort = 'off';
    h.claim('hi');
    assert.ok(h.selectCalls.some((s) => s.reasoningEffort === 'low'), 'off must be clamped to the ladder floor on forced-thinking models');
  } finally { h.cleanup(); }
});

test('modern host with auto dark: a passthrough request is returned untouched (no select churn)', async () => {
  const h = harness({}, undefined, { modern: true });
  try {
    const sel = { ...h.selection };
    const out = await h.request({ reasoningEffort: 'max' });
    loopValidate(out, sel);
    assert.equal(h.selectCalls.length, 0, 'nothing should be selected while auto was never armed');
  } finally { h.cleanup(); }
});

// ===== 0.3.0 adaptive signals =====
const usageEvent = (turn, step, inputTokens, outputTokens) => ({
  type: 'assistant/message',
  data: { turn, step, usage: { inputTokens, outputTokens }, message: { source: { provider: 'bigmodel', model: 'glm-5.3-3-step' } } },
});




test('0.3.0 stats: the savings summary computes against the always-max baseline', async () => {
  const h = harness();
  try {
    h.arm(true);
    const events = [userMsg('x')];
    // 4 low steps (out 100) + 1 max step (out 600): always-max est = 600*5 = 3000, actual = 1000 -> saved ~67%
    for (let s = 1; s <= 4; s += 1) events.push(usageEvent(1, s, 5000, 100));
    events.push(usageEvent(1, 5, 5000, 600));
    await h.request({ reasoningEffort: 'low' }, events, 1, 1);
    await new Promise((r) => setTimeout(r, 30)); // let the throttled push settle
    assert.ok(/^saved ~\d+% output tokens vs always-max \(\d+ steps\)$/.test(h.store.statsSummary || ''), 'summary=' + h.store.statsSummary);
    // pure-function check of the full-turn math: 4 low (100) + 1 max (600) -> est 3000, actual 1000 -> 67%
    const sig = { steps: 5, outTokens: 1000, tierOut: new Map([['low', 400], ['max', 600]]), tierSteps: new Map([['low', 4], ['max', 1]]) };
    assert.ok(statsSummaryOf(sig).includes('saved ~67%'), statsSummaryOf(sig));
  } finally { h.cleanup(); }
});

test('0.3.0 stats: no boost leaks into a clean fresh session (regression)', async () => {
  const h = harness({}, undefined, { modern: true });
  try {
    h.arm(true);
    h.claim('帮我起个游戏id', 1);
    assert.equal(h.selectCalls.at(-1).reasoningEffort, 'low', 'clean session still scores low');
  } finally { h.cleanup(); }
});

// ===== 0.3.1 failure signals =====
const toolResultEvent = (turn, step, text) => ({
  type: 'tool/result',
  data: { turn, step, message: { role: 'tool', toolCallId: 'call_' + turn + '_' + step, content: [{ type: 'text', text }] } },
});

test('0.3.1 fail boost: two failed tool results within 10 min stop the next low', async () => {
  const h = harness({}, undefined, { modern: true });
  try {
    h.arm(true);
    h.broadcast({ id: 'sess-1' }, toolResultEvent(1, 1, 'ok listing'));
    h.broadcast({ id: 'sess-1' }, toolResultEvent(1, 2, 'python script output\n[exit code: 1]'));
    h.broadcast({ id: 'sess-1' }, toolResultEvent(1, 3, '[EXIT_CODE; effects: unknown; retry: never] Do not repeat.'));
    h.claim('帮我起个游戏id', 2);
    assert.equal(h.selectCalls.at(-1).reasoningEffort, 'high', 'two failures must bump low to high');
  } finally { h.cleanup(); }
});

test('0.3.1 fail boost: one failure alone does not bump', async () => {
  const h = harness({}, undefined, { modern: true });
  try {
    h.arm(true);
    h.broadcast({ id: 'sess-1' }, toolResultEvent(1, 1, 'Traceback (most recent call last):\n  File "<stdin>"'));
    h.claim('帮我起个游戏id', 2);
    assert.equal(h.selectCalls.at(-1).reasoningEffort, 'low', 'single failure stays low');
  } finally { h.cleanup(); }
});

// ===== 0.3.3 rc.3 compatibility + routing regressions =====

test('0.3.3 readEvents: a rc.3 session without `events` still feeds the ledger', async () => {
  const h = harness();
  try {
    h.arm(true);
    // Step 1 plans and queues its decision; step 2 then ingests step 1's usage
    // row out of the event log. If readEvents() came back empty the ingest would
    // fall through to the recentUsage fallback and stamp `unknown`.
    await h.request({ reasoningEffort: AUTO }, [userMsg('你好')], 1, 1);
    const events = [userMsg('你好'), usageEvent(1, 1, 5000, 120)];
    await h.request({ reasoningEffort: AUTO }, events, 1, 2);
    await new Promise((r) => setTimeout(r, 40));
    const { readdirSync, readFileSync } = await import('node:fs');
    const names = readdirSync(h.dir).filter((name) => name.startsWith('ledger-'));
    assert.equal(names.length, 1, 'one ledger file per session');
    const records = readFileSync(`${h.dir}/${names[0]}`, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(records.length, 1, 'the usage row must be ingested, not dropped');
    assert.notEqual(records[0].classifierSource, 'unknown', 'a snapshotEvents host must still produce a real decision');
    assert.notEqual(records[0].reason, 'fallback (no events on payload)', 'the events path must be the one used');
  } finally { h.cleanup(); }
});

test('0.3.3 readEvents: the legacy `session.events` array still works', async () => {
  const h = harness({}, undefined, { legacySession: true });
  try {
    h.arm(true);
    await h.request({ reasoningEffort: AUTO }, [userMsg('你好')], 1, 1);
    await h.request({ reasoningEffort: AUTO }, [userMsg('你好'), usageEvent(1, 1, 5000, 120)], 1, 2);
    await new Promise((r) => setTimeout(r, 40));
    const { readdirSync, readFileSync } = await import('node:fs');
    const names = readdirSync(h.dir).filter((name) => name.startsWith('ledger-'));
    assert.equal(names.length, 1);
    const records = readFileSync(`${h.dir}/${names[0]}`, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(records.length, 1, 'pre-rc.3 hosts keep working');
    assert.notEqual(records[0].classifierSource, 'unknown');
  } finally { h.cleanup(); }
});

test('0.3.3 continuity: a light tool call no longer pins the next chat message to high', async () => {
  const h = harness();
  try {
    h.arm(true);
    // A bare `ls`-sized call (args well under the 800-char floor) must not count
    // as "mid-work" — this is the case that kept 你好 on high all day.
    h.broadcast({ id: 'sess-1' }, { type: 'tool/call', data: { name: 'bash', arguments: 'ls -la' } });
    const out = await h.request({ reasoningEffort: AUTO }, [userMsg('你好')]);
    assert.equal(out.reasoningEffort, 'low', 'a short tool call is not continuity evidence');
  } finally { h.cleanup(); }
});

test('0.3.3 continuity: a heavy tool call still pins low up to high', async () => {
  const h = harness();
  try {
    h.arm(true);
    h.broadcast({ id: 'sess-1' }, { type: 'tool/call', data: { name: 'bash', arguments: 'x'.repeat(1200) } });
    const out = await h.request({ reasoningEffort: AUTO }, [userMsg('你好')]);
    assert.equal(out.reasoningEffort, 'high', 'real work still keeps the session off low');
  } finally { h.cleanup(); }
});

test('0.3.3 ledger report: five-level efforts stay distinct and never fall out of the report', async () => {
  const { buildReport } = await import('../lib/ledger.js');
  const rec = (tier, effort, outputTokens) => ({
    ts: 't', sessionId: 's', turn: 1, step: 1, model: 'm', provider: 'p',
    tier, effort, reason: '', classifierSource: 'minimax', classifierScore: 20,
    inputTokens: 0, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0,
  });
  const report = buildReport([rec('low', 'low', 100), rec('high', 'highx', 200), rec('max', 'ultra', 600)]);
  const effortSteps = Object.fromEntries(report.byEffort.map((row) => [row.effort, row.steps]));
  assert.deepEqual(effortSteps, { low: 1, highx: 1, ultra: 1 }, 'every wire effort id gets a bucket');
  assert.deepEqual(report.byEffort.map((row) => row.effort), ['low', 'highx', 'ultra'], 'lightest first');
  const tierSteps = Object.fromEntries(report.byTier.map((row) => [row.tier, row.steps]));
  assert.deepEqual(tierSteps, { low: 1, high: 1, max: 1 }, 'the verdict grouping still separates the three semantic tiers');
  assert.equal(report.totalOutput, 900);
});

test('0.3.3 cache accounting: prompt-cache tokens are recorded alongside the uncached input', async () => {
  const h = harness();
  try {
    h.arm(true);
    const cached = {
      type: 'assistant/message',
      data: {
        turn: 1, step: 1,
        usage: { inputTokens: 900, outputTokens: 150, cacheReadTokens: 4100, cacheWriteTokens: 250 },
        message: { source: { provider: 'bigmodel', model: 'glm-5.3-3-step' } },
      },
    };
    await h.request({ reasoningEffort: AUTO }, [userMsg('你好')], 1, 1);
    await h.request({ reasoningEffort: AUTO }, [userMsg('你好'), cached], 1, 2);
    await new Promise((r) => setTimeout(r, 40));
    const { readdirSync, readFileSync } = await import('node:fs');
    const names = readdirSync(h.dir).filter((name) => name.startsWith('ledger-'));
    const record = JSON.parse(readFileSync(`${h.dir}/${names[0]}`, 'utf8').trim().split('\n')[0]);
    assert.equal(record.inputTokens, 900);
    assert.equal(record.cacheReadTokens, 4100);
    assert.equal(record.cacheWriteTokens, 250);
  } finally { h.cleanup(); }
});

test('0.3.1 calm: two short successful turns drop heuristic high back to low', async () => {
  const h = harness({}, undefined, { modern: true });
  try {
    h.arm(true);
    // turn 1: 3 steps, no failures -> streak 1 (after turn 2 claim)
    await h.request({ reasoningEffort: 'high' }, [userMsg('看看这个目录结构'), usageEvent(1, 1, 5000, 100), usageEvent(1, 2, 5000, 100), usageEvent(1, 3, 5000, 100)], 1, 1);
    h.claim('帮我重构这个模块的架构：\n```\ncode\n```\n看看', 2); // 2 heavy keywords + fence -> 36 heuristic high, streak=1, calm not yet
    assert.equal(h.selectCalls.at(-1).reasoningEffort, 'high', 'streak 1 keeps heuristic high');
    // turn 2: 2 more clean steps -> streak 2 at turn 3 claim
    await h.request({ reasoningEffort: 'high' }, [userMsg('再看一下配置文件'), usageEvent(2, 1, 5000, 100), usageEvent(2, 2, 5000, 100)], 2, 1);
    h.claim('再优化一下这段代码的性能：\n```\ncode\n```\n看看', 3); // heuristic high, calm drops to low
    assert.equal(h.selectCalls.at(-1).reasoningEffort, 'low', 'two calm turns must drop heuristic high to low');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// 0.3.4: the ledger must not depend on the deprecated agent/request hook.
// ---------------------------------------------------------------------------

const ledgerRecords = async (dir) => {
  await new Promise((r) => setTimeout(r, 40));
  const { readdirSync, readFileSync } = await import('node:fs');
  const names = readdirSync(dir).filter((name) => name.startsWith('ledger-'));
  if (names.length === 0) return [];
  return readFileSync(`${dir}/${names[0]}`, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
};

test('0.3.4 ledger: a usage row writes itself from session/event, with no agent/request at all', async () => {
  const h = harness({}, undefined, { modern: true });
  try {
    h.arm(true);
    h.claim('你好', 1);
    // No request() call anywhere in this test: the deprecated hook never fires.
    h.broadcast({ id: 'sess-1' }, usageEvent(1, 1, 5000, 120));
    const records = await ledgerRecords(h.dir);
    assert.equal(records.length, 1, 'the event stream alone must produce a ledger row');
    assert.equal(records[0].turn, 1);
    assert.equal(records[0].step, 1);
    assert.equal(records[0].outputTokens, 120);
    assert.equal(records[0].classifierSource, 'heuristic', 'the claim-time verdict is attributed');
    assert.equal(records[0].tier, 'low');
    assert.equal(records[0].effort, 'low');
  } finally { h.cleanup(); }
});

test('0.3.4 ledger: the same turn:step is never written twice by the two paths', async () => {
  const h = harness();
  try {
    h.arm(true);
    const events = [userMsg('你好'), usageEvent(1, 1, 5000, 120)];
    h.broadcast({ id: 'sess-1' }, usageEvent(1, 1, 5000, 120)); // event path writes it
    await h.request({ reasoningEffort: AUTO }, events, 1, 2);   // catch-up path sees the same row
    const records = await ledgerRecords(h.dir);
    assert.equal(records.length, 1, 'recordUsage dedupes by session:turn:step');
  } finally { h.cleanup(); }
});

test('0.3.4 ledger: rows that predate the plugin still get caught up by agent/request', async () => {
  const h = harness();
  try {
    h.arm(true);
    // Two rows already in the log; neither was broadcast live.
    const events = [userMsg('你好'), usageEvent(1, 1, 5000, 120), usageEvent(1, 2, 6000, 80)];
    await h.request({ reasoningEffort: AUTO }, events, 1, 3);
    const records = await ledgerRecords(h.dir);
    assert.equal(records.length, 2, 'the catch-up sweep backfills the history');
    assert.deepEqual(records.map((r) => r.step), [1, 2]);
  } finally { h.cleanup(); }
});

test('0.3.4 stats: the tooltip accumulator is fed by events, not by the deprecated hook', async () => {
  const h = harness({}, undefined, { modern: true });
  try {
    h.arm(true);
    h.claim('你好', 1);
    for (let step = 1; step <= 4; step += 1) h.broadcast({ id: 'sess-1' }, usageEvent(1, step, 5000, 100));
    await new Promise((r) => setTimeout(r, 60));
    const records = await ledgerRecords(h.dir);
    assert.equal(records.length, 4, 'every step landed');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// 0.3.4: the 800–3199 dead zone is gone — tool load now buys rungs, not a jump.
// ---------------------------------------------------------------------------

test('0.3.4 scheduler: tool argument size buys one rung at 800 and two at 3200', async () => {
  const { rungsForArgs, scheduleEffort } = await import('../lib/scheduler.js');
  assert.equal(rungsForArgs(0), 0);
  assert.equal(rungsForArgs(799), 0);
  assert.equal(rungsForArgs(800), 1, 'the old dead zone now buys a rung');
  assert.equal(rungsForArgs(3199), 1);
  assert.equal(rungsForArgs(3200), 2);
  assert.equal(rungsForArgs(999999), 2, 'two rungs is the ceiling');

  const plan = (heaviest, scoredTier = 'low') =>
    scheduleEffort({ scoredTier, recentCalls: [{ name: 'bash', argsSize: heaviest }], allowToolUpgrade: true, selected: 'auto', defaultTier: 'high' });
  assert.equal(plan(900).effort, 'high', '800-3199 lifts low exactly one rung');
  assert.equal(plan(2000).effort, 'high', 'mid-band is no longer a no-op');
  assert.equal(plan(3300).effort, 'max', '3200+ lifts two rungs');
  assert.equal(plan(3300, 'high').effort, 'max', 'high + two rungs saturates at max');
  assert.equal(plan(3300, 'max').effort, 'max', 'never above the ladder');
  assert.match(plan(2000).reason, /升 1 档/, 'the reason states how many rungs were bought');
  assert.match(plan(3300).reason, /升 2 档/);
});

test('0.3.4 scheduler: allowToolUpgrade=false disables the escalation entirely', async () => {
  const { scheduleEffort } = await import('../lib/scheduler.js');
  const out = scheduleEffort({
    scoredTier: 'low',
    recentCalls: [{ name: 'bash', argsSize: 99999 }],
    allowToolUpgrade: false,
    selected: 'auto',
    defaultTier: 'high',
  });
  assert.equal(out.effort, 'low', 'the toggle must still win');
});

test('0.3.4 scheduler: a manual pick is never escalated by tool load', async () => {
  const { scheduleEffort } = await import('../lib/scheduler.js');
  const out = scheduleEffort({
    scoredTier: 'low',
    recentCalls: [{ name: 'bash', argsSize: 99999 }],
    allowToolUpgrade: true,
    selected: 'low',
    defaultTier: 'high',
  });
  assert.equal(out.effort, 'low');
  assert.equal(out.manual, true);
});

test('0.3.4 scorer backoff: a failed scorer is skipped for the cooldown, then retried', async () => {
  const { ScorerBackoff } = await import('../lib/scheduler.js');
  const backoff = new ScorerBackoff(50);
  assert.equal(backoff.cooling('hello'), false, 'nothing failed yet');
  backoff.markFailed('hello');
  assert.equal(backoff.cooling('hello'), true, 'inside the cooldown the scorer is skipped');
  assert.equal(backoff.cooling('other text'), false, 'a different message still gets a fresh attempt');
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(backoff.cooling('hello'), false, 'the cooldown expires and the scorer is retried');
});

test('0.3.4 scorer backoff: a zero cooldown never suppresses anything', async () => {
  const { ScorerBackoff } = await import('../lib/scheduler.js');
  const backoff = new ScorerBackoff(0);
  backoff.markFailed('hello');
  assert.equal(backoff.cooling('hello'), false);
});

test('0.3.4 scorer backoff: the negative cache stays bounded', async () => {
  const { ScorerBackoff } = await import('../lib/scheduler.js');
  const backoff = new ScorerBackoff(60000);
  for (let i = 0; i < 400; i += 1) backoff.markFailed(`message ${i}`);
  assert.ok(backoff.until.size <= 128, `bounded at 128 entries, got ${backoff.until.size}`);
});

// ---------------------------------------------------------------------------
// 0.3.4: the scorer is authoritative; only an explicit keyword pile-up overrules it.
// ---------------------------------------------------------------------------

test('0.3.4 classifier: a confident low verdict is not overridden by one heavy keyword', async () => {
  const { minimaxClassify } = await import('../lib/classifier.js');
  const stub = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"tier":"low","score":12}' } }] }),
  });
  // "重构" is a heavy keyword (+12) but nowhere near the 70 pile-up threshold.
  const out = await minimaxClassify('重构一下这个函数名', { apiKey: 'k', baseUrl: 'http://x', model: 'm', timeoutMs: 500 }, stub);
  assert.equal(out.tier, 'low', 'the scorer keeps its verdict');
  assert.equal(out.source, 'minimax');
  assert.equal(out.score, 12);
});

test('0.3.4 classifier: a real heavy-keyword pile-up may still lift a low verdict', async () => {
  const { minimaxClassify } = await import('../lib/classifier.js');
  const stub = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"tier":"low","score":10}' } }] }),
  });
  const text = '重构 架构 并发 死锁 调试 优化 性能 迁移 安全 漏洞 加密 benchmark monorepo\n```\ncode\n```';
  const out = await minimaxClassify(text, { apiKey: 'k', baseUrl: 'http://x', model: 'm', timeoutMs: 500 }, stub);
  assert.notEqual(out.tier, 'low', 'a wall of heavy keywords is real evidence');
  assert.equal(out.source, 'minimax+heavy-keywords');
});

test('0.3.4 classifier: an HTTP failure falls back to the heuristic and reports a note', async () => {
  const { minimaxClassify } = await import('../lib/classifier.js');
  const stub = async () => ({ ok: false, status: 503 });
  const out = await minimaxClassify('你好', { apiKey: 'k', baseUrl: 'http://x', model: 'm', timeoutMs: 500 }, stub);
  assert.ok(typeof out.note === 'string' && out.note.length > 0, 'a fallback carries a note so the backoff can mark it');
  assert.ok(['low', 'high', 'max'].includes(out.tier));
});
