import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

const ROOT = '/home/test/Documents/dsh';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Default Host answer for a preparation request. */
const okPrepare = () => Promise.resolve({
  ok: true,
  status: 200,
  json: async () => ({ path: `${ROOT}/2026-11-17/1` }),
});

/**
 * Load the browser bundle into a minimal runtime.
 * @param {object} options - root answer, prepare behaviour, and the session row.
 */
function createRuntime({ configRoot = ROOT, configFails = false, summary = {}, prepareImpl = okPrepare, onStyle } = {}) {
  const cleanups = [];
  const prepareCalls = [];
  const registered = [];
  const originalCalls = [];
  const conversation = {
    sendSession: async (...args) => {
      originalCalls.push(args);
      return { sent: true, args };
    },
  };
  const context = {
    console,
    AbortController,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (cb) => { cb(); return 0; },
    cancelAnimationFrame: () => {},
    navigator: { language: 'zh-CN' },
    fetch: async (path, init) => {
      if (path === '/dsh-no-project/config') {
        if (configFails) return { ok: false, status: 500, json: async () => ({}) };
        return {
          ok: true,
          status: 200,
          json: async () => ({ root: configRoot, workspaceId: 'ws-recent', configured: true }),
        };
      }
      if (path === '/dsh-no-project/prepare') {
        prepareCalls.push(init);
        return prepareImpl(path, init);
      }
      throw new Error(`unexpected fetch: ${path}`);
    },
    window: undefined,
    document: {
      head: {
        appendChild: (el) => { if (typeof onStyle === 'function') onStyle(el); },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      visibilityState: 'visible',
      createElement: () => ({
        dataset: {},
        style: {},
        textContent: '',
        removed: false,
        remove() { this.removed = true; },
      }),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  context.window = context;
  context.window.__ModuleLoader__ = {
    load({ factory }) {
      context.exports = factory((name) => {
        assert.ok(name === 'react' || name === 'react-dom', `unexpected module request: ${name}`);
        return name === 'react-dom' ? { createPortal: (node) => node } : {};
      });
    },
  };
  vm.runInNewContext(clientSource, context, { filename: 'lib/client.js' });

  const ctx = {
    get: (name) => (name === 'conversation' ? conversation : undefined),
    locale: { register: () => {} },    slots: {
      inject: (key, callback) => { callback.call({}); registered.push(key); return () => {}; },
      register: (options) => ({ options }),
    },
    sessions: { list: { getSnapshot: () => ({ byId: { session: summary } }) } },
    workspaces: { create: async ({ path }) => ({ workspaceId: `ws-${path}`, path }) },
    uiWorkspace: { pickDirectory: async () => null },
    remote: { $host: { home: '/home/test' } },
    effect: (install) => {
      const cleanup = install();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return () => {};
    },
  };
  context.exports.apply(ctx);

  return {
    call: (...args) => conversation.sendSession(...args),
    settle: () => context.exports.whenScratchRoot(),
    cleanup: () => { while (cleanups.length > 0) { try { cleanups.pop()(); } catch { /* ignore */ } } },
    prepareCalls,
    originalCalls,
    registered,
    exports: context.exports,
  };
}

test('the bundle loads and declares the services it uses', () => {
  const runtime = createRuntime();
  assert.equal(typeof runtime.exports.apply, 'function');
  for (const service of ['slots', 'locale', 'sessions', 'workspaces', 'uiWorkspace', 'conversation', 'remote']) {
    assert.ok(runtime.exports.inject.includes(service), `inject must list ${service}`);
  }
});

test('apply registers the settings card and shadows the workspace picker', () => {
  const runtime = createRuntime();
  assert.ok(runtime.registered.includes('plugins.bundle.config'));
  assert.ok(runtime.registered.includes('conversation.hero.workspace'));
});

test('a no-project session gets its directory before the prompt is sent', async () => {
  const runtime = createRuntime({ summary: { cwd: ROOT } });
  await runtime.settle();
  const result = await runtime.call({ sessionId: 'session' }, 'hello world', [], 'chat');
  assert.equal(result.sent, true);
  assert.equal(runtime.prepareCalls.length, 1, 'prepared exactly once');
  const body = JSON.parse(runtime.prepareCalls[0].body);
  assert.equal(body.sessionId, 'session');
  // The first message names the folder, so it must reach the Host.
  assert.equal(body.text, 'hello world');
  assert.equal(runtime.originalCalls.length, 1);
});

test('a real project session is left untouched', async () => {
  const runtime = createRuntime({
    summary: { cwd: '/work/project' },
    prepareImpl: () => { throw new Error('prepare must not run'); },
  });
  await runtime.settle();
  const result = await runtime.call({ sessionId: 'session' }, 'hello', [], 'chat');
  assert.equal(result.sent, true);
  assert.equal(runtime.prepareCalls.length, 0);
  assert.equal(runtime.originalCalls.length, 1);
});

test('concurrent sends share one preparation', async () => {
  const response = deferred();
  const runtime = createRuntime({
    summary: { cwd: ROOT },
    prepareImpl: () => response.promise,
  });
  await runtime.settle();
  const first = runtime.call({ sessionId: 'session' }, 'first', [], 'chat');
  const second = runtime.call({ sessionId: 'session' }, 'second', [], 'chat');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.prepareCalls.length, 1);
  response.resolve({ ok: true, status: 200, json: async () => ({ path: `${ROOT}/2026-11-17/1` }) });
  await Promise.all([first, second]);
  assert.equal(runtime.originalCalls.length, 2);
  runtime.cleanup();
});

test('a failed preparation keeps the prompt from being sent', async () => {
  const runtime = createRuntime({
    summary: { cwd: ROOT },
    prepareImpl: () => Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }),
  });
  await runtime.settle();
  await assert.rejects(runtime.call({ sessionId: 'session' }, 'hello', [], 'chat'), /boom/);
  assert.equal(runtime.originalCalls.length, 0);
});

test('the send wrapper forwards the accept callback the composer relies on', async () => {
  const runtime = createRuntime({ summary: { cwd: '/work/project' } });
  await runtime.settle();
  const accept = () => {};
  await runtime.call({ sessionId: 'session' }, 'text', [], 'chat', undefined, accept);
  // Signature: (session, text, attachmentIds, mode, signal, accept)
  assert.equal(runtime.originalCalls[0][5], accept);
});

test('an unreadable root never treats a session as no-project', async () => {
  const runtime = createRuntime({
    configFails: true,
    summary: { cwd: ROOT },
    prepareImpl: () => { throw new Error('prepare must not run'); },
  });
  await runtime.settle();
  const result = await runtime.call({ sessionId: 'session' }, 'hello', [], 'chat');
  assert.equal(result.sent, true);
  assert.equal(runtime.prepareCalls.length, 0, 'no preparation against a guessed root');
});

test('the "最近" row is restyled as a section heading, not a project row', async () => {
  // This Host has no Slot for a Workspace group header, so the row is restyled in
  // place: the folder glyph and the chevron must be hidden and the row must not
  // paint a hover background. The selector keys on the section's workspace id, so
  // it can never reach a real project.
  const styles = [];
  const runtime = createRuntime({ onStyle: (el) => styles.push(el) });
  await runtime.settle();

  const rowRule = styles
    .map(el => el.textContent)
    .find(text => text.includes('data-row-key="workspace:ws-recent"'));
  assert.ok(rowRule, 'a rule must target the section row by workspace id');
  // The two leading spans are the glyph and the chevron; the third is the title.
  assert.match(rowRule, /span:nth-child\(1\)[\s\S]*display: none/);
  assert.match(rowRule, /span:nth-child\(2\)[\s\S]*display: none/);
  // The title itself must never be hidden.
  assert.doesNotMatch(rowRule, /nth-child\(3\)[\s\S]*display: none/);
  // Muted, section-like presentation.
  assert.match(rowRule, /--dsw-alias-label-secondary/);
  assert.match(rowRule, /background: transparent/);
});

test('the section style is removed when the plugin unloads', async () => {
  const styles = [];
  const runtime = createRuntime({ onStyle: (el) => styles.push(el) });
  await runtime.settle();
  assert.ok(styles.length > 0);
  runtime.cleanup();
  assert.ok(styles.some(el => el.removed === true), 'the injected style must be removable');
});

test('the picker offers the no-project entry by asking the Host for its workspace', () => {
  // The section workspace id comes from the Host, so the entry cannot be built
  // from a guessed path.
  assert.ok(clientSource.includes('/dsh-no-project/config'));
  assert.ok(clientSource.includes('workspaceId'));
  assert.ok(clientSource.includes('/dsh-no-project/prepare'));
});
