import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import test from 'node:test';
import {
  apply, Config, directoryNameFromMessage, reserveDirectory, resolveScratchRoot,
} from '../lib/index.js';

/** Minimal request stand-in: async-iterable over the given raw body, if any. */
function ReadableFrom(body) {
  return {
    async *[Symbol.asyncIterator]() {
      if (typeof body === 'string') yield Buffer.from(body);
    },
  };
}

/** Compare workspace paths the way DSH does (Host spelling, no trailing slash). */
function normalizeForCompare(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '');
}

async function fixture(t, { rejection, config, existingWorkspaces } = {}) {
  const tempParent = resolve(tmpdir());
  const root = await mkdtemp(join(tempParent, 'dsh-no-project-test-'));
  t.after(async () => {
    // Only remove the exact unique directory allocated above, never a user root.
    const target = resolve(root);
    assert.ok(isAbsolute(target));
    assert.equal(dirname(target), tempParent);
    assert.ok(basename(target).startsWith('dsh-no-project-test-'));
    await rm(target, { recursive: true, force: true });
  });

  const registrations = new Map();
  const workspaces = [...(existingWorkspaces ?? [])];
  const deletions = [];
  const edits = [];
  const warnings = [];
  const commits = [];
  const paths = new Map();
  const agents = new Map();
  let nextId = 1;

  const editor = {
    edit: async (entry, change) => {
      edits.push(change({ ...(config ?? {}) }, {}));
    },
  };

  const ctx = {
    workspaceRegistry: {
      list: () => workspaces,
      resolveByPath: async (path) => workspaces.find(w => normalizeForCompare(w.path) === normalizeForCompare(path)),
      create: async (path, title) => {
        const workspace = { id: `ws-${nextId++}`, path, title };
        workspaces.push(workspace);
        return workspace;
      },
      delete: async (id) => {
        deletions.push(id);
        const at = workspaces.findIndex(w => w.id === id);
        if (at >= 0) workspaces.splice(at, 1);
        return true;
      },
      insertBefore: async (id) => {
        if (workspaces.at(-1)?.id === id) assert.fail('a last workspace needs no reorder');
      },
    },
    agents: { get: (sessionId) => agents.get(sessionId) },
    workingDirectory: {
      get: (session) => paths.get(session) ?? session.header.cwd,
      set: async (agent, target) => {
        commits.push({ agent, target });
        paths.set(agent.session, target);
      },
    },
    connection: { requestRejection: () => rejection },
    logger: { warn: (message) => warnings.push(message) },
    effect: (install) => install(),
    webServer: {
      register: (route) => {
        registrations.set(route.path, route);
        return () => {};
      },
    },
    get: (name) => (name === 'configEditor' ? editor : undefined),
    fiber: { entry: { id: 'no-project-sessions' } },
  };

  await apply(ctx, { root, ...(config === undefined ? {} : { scratchRoot: config.scratchRoot, root }) });

  async function send(route, { method = 'POST', body } = {}) {
    const req = ReadableFrom(body);
    req.method = method;
    const headers = {};
    let responseBody;
    const res = {
      statusCode: 0,
      setHeader: (key, value) => { headers[key] = value; },
      end: (value) => { responseBody = value; },
    };
    await route.handler(req, res);
    return {
      status: res.statusCode,
      headers,
      body: responseBody === undefined ? undefined : JSON.parse(responseBody),
    };
  }

  function addSession(id, cwd = root) {
    const agent = { session: { header: { cwd, createdAt: new Date(2026, 10, 17, 12).toISOString() } } };
    agents.set(id, agent);
    return agent;
  }

  const prepare = (body, options) => send(registrations.get('/dsh-no-project/prepare'), { ...options, body: body === undefined ? undefined : JSON.stringify(body) });
  const configRequest = (body, options) => send(registrations.get('/dsh-no-project/config'), { ...options, body: body === undefined ? undefined : JSON.stringify(body) });
  return { root, addSession, prepare, configRequest, workspaces, deletions, edits, warnings, commits, paths };
}

test('Config is a native Schemastery schema and passes the activation resolver', () => {
  // DSH's Config projection accepts only a native Schemastery graph; anything
  // else reports `status: 'unsupported'` and hides the bundle's config card.
  assert.equal(Reflect.get(Config, Symbol.for('schemastery')), true);
  assert.equal(typeof Reflect.get(Config, 'type'), 'string');
  const meta = Reflect.get(Config, 'meta');
  assert.ok(meta !== null && typeof meta === 'object');
  assert.ok(Object.hasOwn(Config.dict, 'scratchRoot'));
  const result = Config['~standard'].validate({});
  assert.equal('then' in result, false);
  assert.deepEqual(result.value, { scratchRoot: '' });
  assert.throws(() => {
    const bad = Config['~standard'].validate({ scratchRoot: 5 });
    if (bad.issues) throw new Error(JSON.stringify(bad.issues));
  }, /scratchRoot/);
});

test('resolveScratchRoot honors absolute, relative and empty values', () => {
  const home = homedir();
  assert.equal(resolveScratchRoot(undefined), join(home, 'Documents', 'dsh'));
  assert.equal(resolveScratchRoot('   '), join(home, 'Documents', 'dsh'));
  assert.equal(resolveScratchRoot(''), join(home, 'Documents', 'dsh'));
  const absolute = resolve(tmpdir(), 'nps-absolute-root');
  assert.equal(resolveScratchRoot(absolute), absolute);
  assert.equal(resolveScratchRoot('Notes'), resolve(home, 'Notes'));
});

test('directory names use six ASCII groups and a safe fallback', () => {
  assert.equal(directoryNameFromMessage('Hello, WORLD! 12 34 56 78 ignored'), 'hello-world-12-34-56-78');
  assert.equal(directoryNameFromMessage('中文 / .. \\'), 'new-chat');
  assert.equal(directoryNameFromMessage('A'.repeat(100)), 'a'.repeat(80));
});

test('reserveDirectory uses atomic mkdir and suffixes on collision', async (t) => {
  const parent = await mkdtemp(join(resolve(tmpdir()), 'dsh-nps-num-'));
  t.after(async () => { await rm(parent, { recursive: true, force: true }); });

  assert.equal(await reserveDirectory(parent, 'same'), join(parent, 'same'));
  assert.equal(await reserveDirectory(parent, 'same'), join(parent, 'same-2'));
  // A name already taken by something else is skipped, not reused.
  await mkdir(join(parent, 'same-3'));
  assert.equal(await reserveDirectory(parent, 'same'), join(parent, 'same-4'));
});

test('concurrent reservations never share a directory', async (t) => {
  const parent = await mkdtemp(join(resolve(tmpdir()), 'dsh-nps-race-'));
  t.after(async () => { await rm(parent, { recursive: true, force: true }); });
  const results = await Promise.all(Array.from({ length: 6 }, () => reserveDirectory(parent, 'same')));
  assert.equal(new Set(results).size, 6);
});

test('one Recent workspace holds every no-project session', async (t) => {
  // The section must be a single registration: that is what lists every
  // no-project session in one place instead of one section per conversation.
  const f = await fixture(t);
  const recent = f.workspaces.filter(w => w.title === '最近');
  assert.equal(recent.length, 1);
  assert.equal(recent[0].path, f.root);
});

test('prepare moves the session into a dated folder named from the message', async (t) => {
  const f = await fixture(t);
  const agent = f.addSession('s1');
  const response = await f.prepare({ sessionId: 's1', text: 'hello world' });
  assert.equal(response.status, 200);
  const relative = response.body.path.slice(f.root.length + 1).split(/[\\/]/);
  assert.equal(relative.length, 2, 'the folder is <date>/<slug>');
  assert.match(relative[0], /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(relative[1], 'hello-world');
  assert.equal(f.commits.length, 1, 'the working directory is committed once');
  assert.deepEqual(await readdir(join(f.root, relative[0])), ['hello-world']);

  // The effective working directory moved, while the session keeps belonging to
  // the section: its header cwd is untouched.
  assert.equal(f.paths.get(agent.session), response.body.path);
  assert.equal(agent.session.header.cwd, f.root);
});

test('a Chinese-only message falls back to new-chat', async (t) => {
  const f = await fixture(t);
  f.addSession('cn');
  const response = await f.prepare({ sessionId: 'cn', text: '帮我看看这个' });
  assert.equal(response.status, 200);
  assert.equal(response.body.path.split(/[\\/]/).pop(), 'new-chat');
});

test('duplicate messages get a suffixed folder', async (t) => {
  const f = await fixture(t);
  f.addSession('a');
  f.addSession('b');
  const first = await f.prepare({ sessionId: 'a', text: 'same text' });
  const second = await f.prepare({ sessionId: 'b', text: 'same text' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.path.split(/[\\/]/).pop(), 'same-text');
  assert.equal(second.body.path.split(/[\\/]/).pop(), 'same-text-2');
  assert.equal(f.commits.length, 2);
});

test('concurrent prepares for one session commit exactly once', async (t) => {
  const f = await fixture(t);
  f.addSession('same');
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => f.prepare({ sessionId: 'same', text: 'first text' })),
  );
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.body.path, responses[0].body.path);
  }
  assert.equal(f.commits.length, 1);
});

test('prepare is idempotent: a prepared session keeps its directory', async (t) => {
  const f = await fixture(t);
  f.addSession('a');
  const first = await f.prepare({ sessionId: 'a', text: 'hello' });
  const again = await f.prepare({ sessionId: 'a', text: 'different message' });
  assert.equal(again.status, 200);
  assert.equal(again.body.path, first.body.path);
  assert.equal(again.body.reused, true);
  assert.equal(f.commits.length, 1, 'no second commit for the same session');
});

test('prepare rejects unauthenticated, wrong-method, unready and real-project requests', async (t) => {
  const denied = await fixture(t, { rejection: 401 });
  assert.equal((await denied.prepare({})).status, 401);
  assert.deepEqual(await readdir(denied.root), []);

  const f = await fixture(t);
  const wrongMethod = await f.prepare(undefined, { method: 'GET' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'POST');
  assert.equal((await f.prepare({ sessionId: 'missing' })).status, 409);
  f.addSession('project', join(f.root, 'real-project'));
  assert.equal((await f.prepare({ sessionId: 'project' })).status, 400);
  assert.equal(f.commits.length, 0);
});

test('a stale Recent workspace for another root is retired', async (t) => {
  const f = await fixture(t, {
    existingWorkspaces: [
      { id: 'legacy', path: '/home/test/Documents/dsh', title: '最近' },
      { id: 'project', path: '/work/proj', title: 'proj' },
    ],
  });
  assert.deepEqual(f.deletions, ['legacy']);
  assert.ok(f.workspaces.some(w => w.id === 'project'), 'unrelated workspaces are untouched');
  assert.equal(f.workspaces.filter(w => w.title === '最近').length, 1);
});

test('the config route reports the effective root and saves a new one once', async (t) => {
  const f = await fixture(t);
  const initial = await f.configRequest(undefined, { method: 'GET' });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.root, f.root);
  assert.equal(initial.body.configured, false);
  assert.equal(typeof initial.body.workspaceId, 'string');

  const target = await mkdtemp(join(resolve(tmpdir()), 'dsh-no-project-target-'));
  t.after(async () => { await rm(resolve(target), { recursive: true, force: true }); });

  const saved = await f.configRequest({ root: target });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.root, resolve(target));
  assert.equal(saved.body.restart, true);
  assert.deepEqual(f.edits, [{ scratchRoot: resolve(target) }]);

  const wrongMethod = await f.configRequest(undefined, { method: 'DELETE' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'GET, POST');
});

test('an empty saved root clears the field so the built-in default applies', async (t) => {
  const f = await fixture(t);
  const cleared = await f.configRequest({ root: '   ' });
  assert.equal(cleared.status, 200);
  assert.deepEqual(f.edits, [{}]);
  assert.equal(cleared.body.root, join(homedir(), 'Documents', 'dsh'));
});

test('a profile without a config editor refuses the write instead of claiming success', async (t) => {
  const root = await mkdtemp(join(resolve(tmpdir()), 'dsh-no-project-test-'));
  t.after(async () => { await rm(resolve(root), { recursive: true, force: true }); });
  const registrations = new Map();
  const ctx = {
    workspaceRegistry: {
      list: () => [],
      resolveByPath: async () => undefined,
      create: async (path, title) => ({ id: 'ws', path, title }),
      delete: async () => true,
      insertBefore: async () => {},
    },
    agents: { get: () => undefined },
    workingDirectory: { get: () => root, set: async () => {} },
    connection: { requestRejection: () => undefined },
    logger: { warn: () => {} },
    effect: (install) => install(),
    webServer: { register: (route) => { registrations.set(route.path, route); return () => {}; } },
    // Deliberately no `get('configEditor')`: the entry cannot be written here.
    get: () => undefined,
  };
  await apply(ctx, { root });
  const req = ReadableFrom(JSON.stringify({ root: join(root, 'elsewhere') }));
  req.method = 'POST';
  let responseBody;
  const res = { statusCode: 0, setHeader: () => {}, end: (value) => { responseBody = value; } };
  await registrations.get('/dsh-no-project/config').handler(req, res);
  assert.equal(res.statusCode, 501);
  assert.match(JSON.parse(responseBody).error, /无法保存/);
});
