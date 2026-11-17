import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { apply, directoryNameFromMessage, reserveDirectory, resolveScratchRoot } from '../lib/index.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function fixture(t, { set, rejection, config } = {}) {
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

  let registration;
  const registrations = new Map();
  const agents = new Map();
  const paths = new Map();
  const commits = [];
  const warnings = [];
  const workspaces = [];
  const edits = [];
  const ctx = {
    workspaceRegistry: {
      resolveByPath: async () => undefined,
      create: async (path, title) => {
        const workspace = { id: 'scratch', path, title };
        workspaces.push(workspace);
        return workspace;
      },
      list: () => workspaces,
      insertBefore: async () => assert.fail('a last workspace needs no reorder'),
    },
    agents: { get: (sessionId) => agents.get(sessionId) },
    workingDirectory: {
      get: (session) => paths.get(session) ?? session.header.cwd,
      set: async (agent, target) => {
        commits.push({ agent, target });
        await set?.(agent, target);
        paths.set(agent.session, target);
      },
    },
    connection: { requestRejection: () => rejection },
    logger: { warn: (message) => warnings.push(message) },
    effect: (install) => install(),
    webServer: {
      register: (route) => {
        registrations.set(route.path, route);
        registration = route;
        return () => {};
      },
    },
    get: (name) => (name === 'configEditor' ? editor : undefined),
    fiber: { entry: { id: 'no-project-sessions' } },
  };
  const editor = {
    edit: async (entry, change) => {
      edits.push(change({ ...(config ?? {}) }, {}));
    },
  };
  await apply(ctx, { root, ...(config === undefined ? {} : { scratchRoot: config.scratchRoot, root }) });
  registration = registrations.get('/dsh-no-project/prepare');
  assert.equal(registration.kind, 'exact');
  assert.equal(registration.path, '/dsh-no-project/prepare');
  assert.equal(registrations.get('/dsh-no-project/config').path, '/dsh-no-project/config');
  assert.equal(workspaces[0].title, '最近');
  assert.equal(workspaces[0].path, root);

  function addSession(id, cwd = root) {
    const agent = { session: { header: { cwd, createdAt: new Date(2026, 10, 3, 12).toISOString() } } };
    agents.set(id, agent);
    return agent;
  }

  async function send(route, body = {}, { method = 'POST', raw } = {}) {
    const req = Readable.from([Buffer.from(raw ?? JSON.stringify(body))]);
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

  const request = (body, options) => send(registration, body, options);
  const configRequest = (body, options) => send(registrations.get('/dsh-no-project/config'), body, options);
  return { root, addSession, request, configRequest, commits, paths, warnings, edits };
}

test('directory names use six ASCII groups and a safe fallback', () => {
  assert.equal(directoryNameFromMessage('Hello, WORLD! 12 34 56 78 ignored'), 'hello-world-12-34-56-78');
  assert.equal(directoryNameFromMessage('中文 / .. \\'), 'new-chat');
  assert.equal(directoryNameFromMessage('A'.repeat(100)), 'a'.repeat(80));
});

test('reserveDirectory uses atomic mkdir to avoid collisions', async (t) => {
  const { root } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => reserveDirectory(root, 'same')));
  assert.equal(new Set(results).size, 6);
  assert.deepEqual((await readdir(root)).sort(), ['same', 'same-2', 'same-3', 'same-4', 'same-5', 'same-6']);
});

test('concurrent same-session requests allocate and commit exactly one directory', async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, { set: async () => { entered.resolve(); await release.promise; } });
  f.addSession('same');
  const first = f.request({ sessionId: 'same', text: 'first message' });
  await entered.promise;
  const followers = Array.from({ length: 5 }, (_, index) =>
    f.request({ sessionId: 'same', text: `different browser ${index}` }));
  // Let every async request body drain while the first durable commit is held.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.commits.length, 1);
  release.resolve();
  const responses = await Promise.all([first, ...followers]);
  const target = join(f.root, '2026-11-03', 'first-message');
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.body.path, target);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(f.commits.length, 1);
  assert.deepEqual(await readdir(join(f.root, '2026-11-03')), ['first-message']);

  const repeated = await f.request({ sessionId: 'same', text: 'later message' });
  assert.deepEqual(repeated.body, { path: target, reused: true });
  assert.equal(f.commits.length, 1);
});

test('a pending session does not block another session with the same directory name', async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, {
    set: async (agent) => {
      if (agent === firstAgent) { entered.resolve(); await release.promise; }
    },
  });
  const firstAgent = f.addSession('first');
  f.addSession('second');
  const first = f.request({ sessionId: 'first', text: 'identical' });
  await entered.promise;
  try {
    const second = await f.request({ sessionId: 'second', text: 'identical' });
    assert.equal(second.status, 200);
    assert.equal(second.body.path, join(f.root, '2026-11-03', 'identical-2'));
    assert.equal(f.commits.length, 2);
  } finally {
    release.resolve();
    await first;
  }
});

test('a failed shared commit cleans its reservation and allows retry', async (t) => {
  const entered = deferred();
  const release = deferred();
  let attempts = 0;
  const f = await fixture(t, {
    set: async () => {
      attempts += 1;
      if (attempts === 1) {
        entered.resolve();
        await release.promise;
        throw new Error('durable commit failed');
      }
    },
  });
  f.addSession('retry');
  const first = f.request({ sessionId: 'retry', text: 'retry me' });
  await entered.promise;
  const follower = f.request({ sessionId: 'retry', text: 'different text' });
  await new Promise((resolve) => setImmediate(resolve));
  release.resolve();
  const responses = await Promise.all([first, follower]);
  for (const response of responses) {
    assert.equal(response.status, 500);
    assert.equal(response.body.error, 'durable commit failed');
  }
  assert.equal(attempts, 1);
  assert.deepEqual(await readdir(join(f.root, '2026-11-03')), []);
  const retry = await f.request({ sessionId: 'retry', text: 'retry me' });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.path, join(f.root, '2026-11-03', 'retry-me'));
  assert.equal(attempts, 2);
});

test('route rejects unauthenticated, wrong-method, unready and real-project requests', async (t) => {
  const denied = await fixture(t, { rejection: 401 });
  assert.equal((await denied.request({})).status, 401);
  assert.deepEqual(await readdir(denied.root), []);

  const f = await fixture(t);
  const wrongMethod = await f.request({}, { method: 'GET' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'POST');
  assert.equal((await f.request({ sessionId: 'missing' })).status, 409);
  f.addSession('project', join(f.root, 'real-project'));
  assert.equal((await f.request({ sessionId: 'project', text: 'do not allocate' })).status, 400);
  assert.equal((await f.request({}, { raw: '{bad json' })).status, 500);
  assert.equal((await f.request({}, { raw: 'x'.repeat(64 * 1024 + 1) })).status, 500);
  assert.equal(f.commits.length, 0);
  assert.deepEqual(await readdir(f.root), []);
});

test('Config is a native Schemastery schema and passes the activation resolver', async () => {
  const { Config } = await import('../lib/index.js');
  // DSH's Config projection accepts only a native Schemastery graph; anything
  // else reports `status: 'unsupported'` and hides the bundle's config card.
  // `isNativeConfigSchema` checks exactly these three things.
  assert.equal(Reflect.get(Config, Symbol.for('schemastery')), true);
  assert.equal(typeof Reflect.get(Config, 'type'), 'string');
  const meta = Reflect.get(Config, 'meta');
  assert.ok(meta !== null && typeof meta === 'object');
  // The declared field is what the settings page reads and writes.
  assert.ok(Object.hasOwn(Config.dict, 'scratchRoot'));

  // Cordis resolves a plugin's Config through `Config['~standard'].validate`;
  // a throwing, absent, or async validator would break activation.
  const validate = (value) => {
    const result = Config['~standard'].validate(value);
    assert.equal('then' in result, false, 'config validation must be synchronous');
    if (result.issues) throw new Error(JSON.stringify(result.issues));
    return result.value;
  };
  assert.deepEqual(validate({}), { scratchRoot: '' });
  assert.deepEqual(validate({ scratchRoot: 'C:/Notes' }), { scratchRoot: 'C:/Notes' });
  assert.throws(() => validate({ scratchRoot: 5 }), /scratchRoot/);
});

test('resolveScratchRoot honors absolute, relative and empty values', () => {
  const home = homedir();
  assert.equal(resolveScratchRoot(undefined), join(home, 'Documents', 'dsh'));
  assert.equal(resolveScratchRoot('   '), join(home, 'Documents', 'dsh'));
  assert.equal(resolveScratchRoot(''), join(home, 'Documents', 'dsh'));
  const absolute = resolve(tmpdir(), 'nps-absolute-root');
  assert.equal(resolveScratchRoot(absolute), absolute);
  assert.equal(resolveScratchRoot('Notes'), resolve(home, 'Notes'));
  assert.equal(resolveScratchRoot('  Notes  '), resolve(home, 'Notes'));
});

test('the config route reports the effective root and saves a new one once', async (t) => {
  const f = await fixture(t);
  const initial = await f.configRequest({}, { method: 'GET' });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.root, f.root);
  assert.equal(initial.body.configured, false);

  const target = await mkdtemp(join(resolve(tmpdir()), 'dsh-no-project-target-'));
  t.after(async () => { await rm(resolve(target), { recursive: true, force: true }); });

  const saved = await f.configRequest({ root: target });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.root, resolve(target));
  assert.equal(saved.body.restart, true);
  // The write replaces the row's whole config, dropping any previous value.
  assert.deepEqual(f.edits, [{ scratchRoot: resolve(target) }]);

  // Only GET and POST are served.
  const wrongMethod = await f.configRequest({}, { method: 'DELETE' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'GET, POST');

  // Authentication applies to this route exactly as it does to prepare.
  const denied = await fixture(t, { rejection: 401 });
  assert.equal((await denied.configRequest({}, { method: 'GET' })).status, 401);
  assert.equal((await denied.configRequest({ root: target })).status, 401);
  assert.deepEqual(denied.edits, []);
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
      resolveByPath: async () => undefined,
      create: async (path, title) => ({ id: 'scratch', path, title }),
      list: () => [],
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
  const req = Readable.from([Buffer.from(JSON.stringify({ root: join(root, 'elsewhere') }))]);
  req.method = 'POST';
  let responseBody;
  const res = {
    statusCode: 0,
    setHeader: () => {},
    end: (value) => { responseBody = value; },
  };
  await registrations.get('/dsh-no-project/config').handler(req, res);
  assert.equal(res.statusCode, 501);
  assert.match(JSON.parse(responseBody).error, /无法保存/);
});
