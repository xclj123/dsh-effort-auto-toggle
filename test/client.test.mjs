/**
 * Offline client-half tests for dsh-effort-auto-toggle.
 *
 * The shipped `lib/client.js` is a `window.__ModuleLoader__.load({factory})`
 * bundle. This harness gives it a fake loader + fake react, then drives the
 * registered components directly — the same entry points the web shell uses
 * (`ctx.slots.inject` / `ctx.locale.register`), with no browser and no DSH
 * process involved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

function loadBundle() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const react = {
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    Fragment: 'Fragment',
    createElement: (type, props) => ({ type, props: props ?? {} }),
  };
  const jsxRuntime = {
    Fragment: 'Fragment',
    jsx: (type, props) => ({ type, props: props ?? {} }),
    jsxs: (type, props) => ({ type, props: props ?? {} }),
  };
  let bundle;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: ({ id, factory }) => {
          bundle = { id, exports: factory((name) => (name === 'react' ? react : jsxRuntime)) };
        },
      },
    },
    console,
  };
  runInContext(source, createContext(sandbox), { filename: 'lib/client.js' });
  return bundle;
}

function makeCtx() {
  const registrations = [];
  const settings = [];
  const servedScopes = new Map();
  const configForms = {
    describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'dsh-effort-auto-toggle' }] } }) }),
    get: (ns) => {
      if (!servedScopes.has(ns)) servedScopes.set(ns, fakeScope({}));
      return servedScopes.get(ns);
    },
  };
  const ctx = {
    configForms,
    inject: (deps, cb) => {
      try { cb(ctx); } catch { /* optional service not present */ }
      return () => {};
    },
    effect: (fn) => { const out = fn(); return typeof out === 'function' ? out : () => {}; },
    locale: { register: (ns, dicts) => { registrations.push({ kind: 'locale', ns, dicts }); return { ns }; } },
    slots: {
      inject: (_name, generator) => {
        const iterator = generator();
        iterator.next(); // runs up to the yield, i.e. performs the registration
        return { dispose: () => iterator.return?.() };
      },
      register: (spec, component) => {
        registrations.push({ kind: 'slot', spec, component });
        return { id: `${spec.name}:${spec.id}` };
      },
    },
  };
  return { ctx, registrations, settings };
}

// 0.1.6: fake client sessions service exposing per-session projection faces,
// mirroring binding(id).session.projections.faceOf('modelSelection').
function attachSessions(harness, { sessionId = 'sess-1', effort = 'low' } = {}) {
  const face = {
    subscribe: () => () => {},
    getSnapshot: () => ({ lastUsed: { provider: 'modlens-bigmodel', model: 'glm-5.3', reasoningEffort: effort }, next: null }),
  };
  harness.ctx.sessions = {
    binding: (id) => (id === sessionId ? {
      session: { projections: { faceOf: (key) => (key === 'modelSelection' ? face : undefined) } },
    } : undefined),
  };
  return face;
}

function fakeScope(value) {
  const calls = [];
  const scope = {
    calls,
    subscribe: () => () => {},
    getSnapshot: () => ({ status: 'ready', writable: true, value }),
    set: (key, next) => { calls.push([key, next]); value[key] = next; },
    unset: (key) => { calls.push([key, undefined]); delete value[key]; },
  };
  return scope;
}

const t = (key) => key;
const flatten = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) flatten(child, out); return out; }
  if (!node || typeof node !== 'object') return out;
  // Expand nested function components the way react would render them.
  if (typeof node.type === 'function') return flatten(node.type(node.props ?? {}), out);
  out.push(node);
  if (node.props && node.props.children !== undefined) flatten(node.props.children, out);
  return out;
};

test('bundle loads and exports apply/inject', () => {
  const bundle = loadBundle();
  assert.equal(bundle.id, 'dsh-effort-auto-toggle');
  assert.equal(typeof bundle.exports.apply, 'function');
  assert.deepEqual([...bundle.exports.inject], ['slots', 'locale', 'configForms']);
});

test('message badge jump aligns to the turn HEAD row, not the tail', () => {
  const { ctx, registrations } = makeCtx();
  loadBundle().exports.apply(ctx);
  const { component } = registrations.find((r) => r.kind === 'slot' && r.spec.name === 'conversation.chat.assistant-actions');

  const turnHeadRow = { getBoundingClientRect: () => ({ top: 220 }) };
  const flow = { querySelector: (sel) => (sel === '[data-chat-turn="7"]' ? turnHeadRow : null) };
  const scroller = {
    closest: () => scroller,
    querySelector: (sel) => (sel === '[data-slot="conversation.chat.flow"]' ? flow : null),
    scrollTop: 5000,
    getBoundingClientRect: () => ({ top: 100 }),
  };
  const tail = {
    closest: (sel) => (sel === '[data-turn-tail]' ? tail : scroller),
    getAttribute: (name) => (name === 'data-turn-tail' ? '7' : null),
    getBoundingClientRect: () => ({ top: 700 }),
  };

  const meta = { useTrajectory: () => ({ model: 'glm-5.3', effort: 'low', outputTokens: 12 }) };
  const badge = component({ t, messageId: 'm1', useSession: undefined, useTrajectory: meta.useTrajectory });
  badge.props.onClick({ currentTarget: tail });
  // delta = 220 - 100 = 120; target = 5000 + 120 - 24 = 5096 (turn HEAD, not tail 700)
  assert.equal(scroller.scrollTop, 5096, 'aligns the turn head row 24px below the scroller top');
});

test('message badge jump falls back to the outermost anchor row without turn-tail', () => {
  const { ctx, registrations } = makeCtx();
  loadBundle().exports.apply(ctx);
  const { component } = registrations.find((r) => r.kind === 'slot' && r.spec.name === 'conversation.chat.assistant-actions');

  const innerRow = { hasAttribute: (n) => n === 'data-chat-anchor-key', getBoundingClientRect: () => ({ top: 310 }) };
  const outerRow = { hasAttribute: (n) => n === 'data-chat-anchor-key', getBoundingClientRect: () => ({ top: 300 }) };
  const scroller = {
    closest: () => scroller,
    querySelector: () => null,
    scrollTop: 2000,
    getBoundingClientRect: () => ({ top: 0 }),
  };
  const badgeDom = {
    closest: (sel) => (sel === '[data-conversation-scroll]' ? scroller : null),
    hasAttribute: () => false,
    parentElement: innerRow,
  };
  innerRow.parentElement = outerRow;
  outerRow.parentElement = scroller;

  const meta = { useTrajectory: () => ({ model: 'glm-5.3', effort: 'low', outputTokens: 12 }) };
  const badge = component({ t, messageId: 'm1', useSession: undefined, useTrajectory: meta.useTrajectory });
  badge.props.onClick({ currentTarget: badgeDom });
  // outermost anchor row top=300 -> 2000 + 300 - 24 = 2276
  assert.equal(scroller.scrollTop, 2276, 'falls back to the OUTERMOST anchor row');
});

test('apply registers the composer button, the settings card and the message badge', () => {
  const { ctx, registrations } = makeCtx();
  loadBundle().exports.apply(ctx);
  const slots = registrations.filter((r) => r.kind === 'slot').map((r) => r.spec.name);
  assert.deepEqual(slots.sort(), [
    'conversation.chat.assistant-actions',
    'conversation.input.right',
    'settings.plugin.item',
  ]);
  const button = registrations.find((r) => r.kind === 'slot' && r.spec.name === 'conversation.input.right');
  assert.equal(button.spec.id, 'effort-auto-toggle-button');
  assert.equal(button.spec.order, 10);
  assert.equal(typeof button.component, 'function');
});

test('the button is a real toggle: dim when off, lit when on, click flips the setting', () => {
  const { ctx, registrations } = makeCtx();
  loadBundle().exports.apply(ctx);
  const { component } = registrations.find((r) => r.kind === 'slot' && r.spec.name === 'conversation.input.right');

  const off = fakeScope({ autoOn: false });
  const dim = flatten(component({ t, scope: off })).find((n) => n.type === 'button' && n.props['aria-label'] === 'effort-auto-toggle-button');
  assert.ok(dim, 'inner button found inside the wrapper div');
  assert.equal(dim.props['aria-pressed'], 'false');
  assert.equal(dim.props.disabled, false);
  assert.match(dim.props.style.border, /1px solid/);

  const on = fakeScope({ autoOn: true });
  const lit = flatten(component({ t, scope: on })).find((n) => n.type === 'button' && n.props['aria-label'] === 'effort-auto-toggle-button');
  assert.equal(lit.props['aria-pressed'], 'true');
  assert.match(lit.props.style.background, /linear-gradient/);

  lit.props.onClick();
  assert.deepEqual(on.calls, [['autoOn', false]], 'clicking a lit button switches auto OFF');

  dim.props.onClick();
  assert.deepEqual(off.calls, [['autoOn', true]], 'clicking a dim button switches auto ON');
});

test('the button refuses to act when the settings namespace is unavailable', () => {
  const { ctx, registrations } = makeCtx();
  loadBundle().exports.apply(ctx);
  const { component } = registrations.find((r) => r.kind === 'slot' && r.spec.name === 'conversation.input.right');
  const scope = { subscribe: () => () => {}, getSnapshot: () => ({ status: 'unavailable' }), set: () => { throw new Error('must not be called'); } };
  const node = flatten(component({ t, scope })).find((n) => n.type === 'button' && n.props['aria-label'] === 'effort-auto-toggle-button');
  assert.ok(node, 'inner button found inside the wrapper div');
  assert.equal(node.props.disabled, true);
  node.props.onClick(); // must be a no-op, not a throw
});

test('the settings card renders an autoOn switch wired to the same namespace', () => {
  const { ctx, registrations } = makeCtx();
  loadBundle().exports.apply(ctx);
  const { component } = registrations.find((r) => r.kind === 'slot' && r.spec.name === 'settings.plugin.item');
  const scope = fakeScope({ autoOn: false, mode: 'heuristic', enabled: true, allowToolUpgrade: true });
  const tree = flatten(component({ t, scope }));
  const checkbox = tree.find((n) => n.type === 'input' && n.props.type === 'checkbox' && n.props.id === 'plugin-config-effort-auto-toggle-autoon');
  assert.ok(checkbox, 'autoOn checkbox should exist');
  checkbox.props.onChange({ currentTarget: { checked: true } });
  assert.deepEqual(scope.calls, [['autoOn', true]]);
});

test('0.1.6 live tier: the lit button shows the last actually-used effort from modelSelection', () => {
  const { ctx, registrations } = makeCtx();
  loadBundle().exports.apply(ctx);
  const { component } = registrations.find((r) => r.kind === 'slot' && r.spec.name === 'conversation.input.right');
  attachSessions({ ctx }, { sessionId: 'sess-9', effort: 'low' });

  const scope = fakeScope({ autoOn: true });
  const tree = flatten(component({ t, scope, sessionId: 'sess-9', ctx }));
  const span = tree.find((n) => n.type === 'span' && typeof n.props.children === 'string' && n.props.children.includes('·'));
  assert.ok(span, 'lit button should carry a tier-suffixed label');
  assert.equal(span.props.children, 'btn.auto·low');
});

test('0.1.6 live tier: without a sessions service the button keeps the plain label', () => {
  const { ctx, registrations } = makeCtx();
  loadBundle().exports.apply(ctx);
  const { component } = registrations.find((r) => r.kind === 'slot' && r.spec.name === 'conversation.input.right');

  const scope = fakeScope({ autoOn: true });
  const tree = flatten(component({ t, scope, sessionId: 'sess-9', ctx }));
  const span = tree.find((n) => n.type === 'span' && n.props.children === 'btn.auto');
  assert.ok(span, 'fallback label should stay plain');
});

test('0.1.6 live tier: unknown effort values map to the shared default label', () => {
  const { ctx, registrations } = makeCtx();
  loadBundle().exports.apply(ctx);
  const { component } = registrations.find((r) => r.kind === 'slot' && r.spec.name === 'conversation.input.right');
  attachSessions({ ctx }, { sessionId: 'sess-1', effort: 'ultra' });

  const scope = fakeScope({ autoOn: true });
  const tree = flatten(component({ t, scope, sessionId: 'sess-1', ctx }));
  const span = tree.find((n) => n.type === 'span' && typeof n.props.children === 'string' && n.props.children.includes('·'));
  assert.equal(span.props.children, 'btn.auto·ultra');
});

test('0.1.7 nested inject captures the sessions service even when it is not a ctx property', () => {
  const { ctx, registrations } = makeCtx();
  attachSessions({ ctx }, { sessionId: 'sess-5', effort: 'high' });
  loadBundle().exports.apply(ctx); // nested inject fires with scope=ctx, capturing ctx.sessions
  delete ctx.sessions;             // cordis reality: services are not plain ctx properties
  const { component } = registrations.find((r) => r.kind === 'slot' && r.spec.name === 'conversation.input.right');
  const tree = flatten(component({ t, scope: fakeScope({ autoOn: true }), sessionId: 'sess-5', ctx }));
  const span = tree.find((n) => n.type === 'span' && typeof n.props.children === 'string' && n.props.children.includes('·'));
  assert.ok(span, 'sessionsRef path should still reach the projection face');
  assert.equal(span.props.children, 'btn.auto·high');
});

// 0.2.4: first-run key tip popover on the composer toggle.
test('key tip popover appears when armed, scored mode, and keyless', () => {
  const { ctx, registrations } = makeCtx();
  loadBundle().exports.apply(ctx);
  const { component } = registrations.find((r) => r.kind === 'slot' && r.spec.name === 'conversation.input.right');
  const scope = fakeScope({ autoOn: true, mode: 'minimax', minimaxApiKey: '' });
  const nodes = flatten(component({ t, scope }));
  assert.ok(nodes.some((n) => n.props && n.props['aria-label'] === 'effort-auto-toggle-keytip'), 'popover renders above the toggle');
  assert.ok(nodes.some((n) => n.props && n.props['aria-label'] === 'effort-auto-toggle-keytip-key'), 'key input renders');
  assert.ok(nodes.some((n) => n.type === 'strong' && n.props.children === 'keytip.title'), 'title renders');
});

test('key tip saves the pasted key through the settings form', () => {
  const { ctx, registrations } = makeCtx();
  loadBundle().exports.apply(ctx);
  const { component } = registrations.find((r) => r.kind === 'slot' && r.spec.name === 'conversation.input.right');
  const scope = fakeScope({ autoOn: true, mode: 'minimax', minimaxApiKey: '' });
  const nodes = flatten(component({ t, scope }));
  const keyInput = nodes.find((n) => n.props && n.props['aria-label'] === 'effort-auto-toggle-keytip-key');
  keyInput.props.onChange({ target: { value: 'sk-test-123' } });
  const save = nodes.find((n) => n.props && n.props['aria-label'] === 'effort-auto-toggle-keytip-save');
  save.props.onClick();
  assert.deepEqual(scope.calls.filter(([k]) => k === 'minimaxApiKey'), [['minimaxApiKey', 'sk-test-123']]);
});

test('key tip keep-heuristic switches the classifier mode', () => {
  const { ctx, registrations } = makeCtx();
  loadBundle().exports.apply(ctx);
  const { component } = registrations.find((r) => r.kind === 'slot' && r.spec.name === 'conversation.input.right');
  const scope = fakeScope({ autoOn: true, mode: 'minimax', minimaxApiKey: '' });
  const nodes = flatten(component({ t, scope }));
  const keep = nodes.find((n) => n.props && n.props['aria-label'] === 'effort-auto-toggle-keytip-heuristic');
  keep.props.onClick();
  assert.deepEqual(scope.calls.filter(([k]) => k === 'mode'), [['mode', 'heuristic']]);
});

test('key tip stays hidden when a key is configured or mode is heuristic', () => {
  const { ctx, registrations } = makeCtx();
  loadBundle().exports.apply(ctx);
  const { component } = registrations.find((r) => r.kind === 'slot' && r.spec.name === 'conversation.input.right');
  const withKey = fakeScope({ autoOn: true, mode: 'minimax', minimaxApiKey: 'sk-live' });
  assert.ok(!flatten(component({ t, scope: withKey })).some((n) => n.props && n.props['aria-label'] === 'effort-auto-toggle-keytip'), 'no popover with a key');
  const heuristic = fakeScope({ autoOn: true, mode: 'heuristic', minimaxApiKey: '' });
  assert.ok(!flatten(component({ t, scope: heuristic })).some((n) => n.props && n.props['aria-label'] === 'effort-auto-toggle-keytip'), 'no popover in heuristic mode');
  const disarmed = fakeScope({ autoOn: false, mode: 'minimax', minimaxApiKey: '' });
  assert.ok(!flatten(component({ t, scope: disarmed })).some((n) => n.props && n.props['aria-label'] === 'effort-auto-toggle-keytip'), 'no popover while disarmed');
});
