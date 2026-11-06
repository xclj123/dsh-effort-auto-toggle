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
import { apply, DEFAULT_CONFIG } from '../lib/index.js';

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
  const agentOf = (events = []) => ({ session: { id: 'sess-1', events }, ...(modelApi ? { model: modelApi } : {}) });
  const request = (seed, events = [], turn = 1, step = 1) =>
    handlers.get('agent/request').cb(
      { turn, step, agent: agentOf(events) },
      async () => ({ provider: 'bigmodel', model: 'glm-5.3-' + efforts.length + '-step', ...seed }),
    );
  const claim = (text, turn = 1) =>
    handlers.get('agent/inbox/claimed').cb({ message: { role: 'user', content: [{ type: 'text', text }] }, turn, agent: agentOf() });
  const broadcast = (session, event) => handlers.get('session/event').cb(session, event);
  // 0.2.6: the toggle's source of truth is override-state.json (the host
  // settings write path is dead on 0.2.2-rc.1); arm() simulates the file flip.
  const arm = (on) => writeFileSync(join(dir, 'override-state.json'), JSON.stringify({ sessionId: null, autoOn: on, ts: Date.now() }));
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
