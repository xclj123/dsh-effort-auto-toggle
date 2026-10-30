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

test('message badge jump mirrors the host scroller posture', () => {
  const { ctx, registrations } = makeCtx();
  loadBundle().exports.apply(ctx);
  const { component } = registrations.find((r) => r.kind === 'slot' && r.spec.name === 'conversation.chat.assistant-actions');

  const rows = [];
  const row = {
    closest: (sel) => (sel.includes('data-chat-anchor-key') ? row : scroller),
    getBoundingClientRect: () => ({ top: 700 }),
    scrollIntoViewCalls: [],
  };
  const scroller = {
    closest: () => null,
    scrollTop: 5000,
    getBoundingClientRect: () => ({ top: 100 }),
  };
  row.closest = (sel) => (sel.includes('data-chat-anchor-key') ? row : scroller);
  rows.push(row, scroller);

  const meta = { useTrajectory: () => ({ model: 'glm-5.3', effort: 'low', outputTokens: 12 }) };
  const badge = component({ t, messageId: 'm1', useSession: undefined, useTrajectory: meta.useTrajectory });
  assert.equal(badge.type, 'button');
  assert.equal(badge.props.onClick.name, 'jumpToMessage');
  badge.props.onClick({ currentTarget: { closest: () => row } });
  // delta = 700 - 100 = 600; target = 5000 + 600 - 24 = 5576
  assert.equal(scroller.scrollTop, 5576, 'aligns the row 24px below the scroller top, host style');

  // no conversation scroller above the row: falls back to scrollIntoView
  const orphan = { closest: () => null, getBoundingClientRect: () => ({ top: 0 }), scrolled: [] };
  orphan.scrollIntoView = (opts) => orphan.scrolled.push(opts);
  scroller.scrollTop = -1; // poison: must not be touched in this branch
  badge.props.onClick({ currentTarget: { closest: () => orphan } });
  assert.equal(JSON.stringify(orphan.scrolled), JSON.stringify([{ behavior: 'smooth', block: 'start' }]));
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
  const dim = component({ t, scope: off });
  assert.equal(dim.type, 'button');
  assert.equal(dim.props['aria-pressed'], 'false');
  assert.equal(dim.props.disabled, false);
  assert.match(dim.props.style.border, /1px solid/);

  const on = fakeScope({ autoOn: true });
  const lit = component({ t, scope: on });
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
  const node = component({ t, scope });
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
