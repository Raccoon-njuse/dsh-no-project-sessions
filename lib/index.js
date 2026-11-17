/**
 * No-project sessions — Host half.
 *
 * Owns ONE Workspace whose path is the user's draft root, presented in the
 * sidebar as the "最近" section. Every session created inside it therefore
 * belongs to that one section and is listed there in order.
 *
 * On the first message the Session's effective working directory is moved into
 * its own `<root>/<YYYY-MM-DD>/<n>` folder, so each conversation gets a dated,
 * numbered directory of its own while still belonging to "最近". The session's
 * `header.cwd` stays the root on purpose: DSH matches a session to a Workspace
 * by exact path equality, so moving the header would drop the session out of
 * the section.
 *
 * The draft root defaults to `<home>/Documents/dsh` and is set once through the
 * bundle's own settings page (which writes `config.scratchRoot` and restarts
 * this row). Two authenticated routes serve the client:
 * `POST /dsh-no-project/prepare` reserves the numbered folder for a session and
 * commits it as its working directory, and `/dsh-no-project/config` reads and
 * writes the root.
 */
import { mkdir, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';

export const inject = [
  'workspaceRegistry',
  'agents',
  'workingDirectory',
  'webServer',
  'connection',
];

/** Title of the Workspace that collects every no-project session. */
const SCRATCH_TITLE = '最近';
const PREPARE_PATH = '/dsh-no-project/prepare';
const CONFIG_PATH = '/dsh-no-project/config';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_DIRECTORY_ATTEMPTS = 10_000;

/** Default draft root, used until the user changes it in the plugin's page. */
function defaultScratchRoot() {
  return join(homedir(), 'Documents', 'dsh');
}

/**
 * Resolve the configured draft root to one absolute path.
 * A relative value is resolved against the user's home so a hand-written
 * `config.scratchRoot: Notes` still lands somewhere predictable.
 * @param {unknown} configured - the row's `config.scratchRoot`.
 * @returns {string} an absolute directory path.
 */
export function resolveScratchRoot(configured) {
  const value = typeof configured === 'string' ? configured.trim() : '';
  if (value === '') return defaultScratchRoot();
  return isAbsolute(value) ? resolve(value) : resolve(homedir(), value);
}

/**
 * Declared so the Loader validates and projects this row's `config`, and so the
 * Plugins page can render the field this plugin reads.
 *
 * This must be a real Schemastery schema: DSH's `Config.listConfigs` projection
 * accepts only a native Schemastery graph (`isNativeConfigSchema` checks the
 * `Symbol.for('schemastery')` marker, a string `type`, and a `meta` object) and
 * reports anything else as `status: 'unsupported'`, which hides the bundle's
 * configuration card.
 */
export const Config = z.object({
  scratchRoot: z.string().default(''),
});

/** Local calendar date for a timestamp, matching the directory layout. */
function localDate(createdAt) {
  const date = new Date(createdAt);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Derive a filesystem-safe directory name from the first message: the first
 * six runs of ASCII letters/digits, lowercased and joined with hyphens, capped
 * at 80 code units. An empty result falls back to `new-chat`.
 * @param {string} text - the first user message.
 * @returns {string} the preferred final path segment.
 */
export function directoryNameFromMessage(text) {
  const groups = (String(text).match(/[A-Za-z0-9]+/g) ?? [])
    .slice(0, 6)
    .map((group) => group.toLowerCase());
  const name = groups.join('-').slice(0, 80).replace(/-+$/, '');
  return name === '' ? 'new-chat' : name;
}

/**
 * Reserve a unique child directory using mkdir's atomic EEXIST signal, so two
 * concurrent preparations can never share a name. The preferred name is used
 * first, then `-2`, `-3`, and so on.
 * @param {string} parent - existing parent directory.
 * @param {string} base - the preferred final segment.
 * @returns {Promise<string>} the full path that this call created.
 */
export async function reserveDirectory(parent, base) {
  for (let index = 1; index <= MAX_DIRECTORY_ATTEMPTS; index += 1) {
    const name = index === 1 ? base : `${base}-${index}`;
    const target = join(parent, name);
    try {
      await mkdir(target);
      return target;
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error(`could not allocate a unique directory for "${base}"`);
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function normalized(path) {
  return String(path).replace(/\\/g, '/').replace(/\/+$/, '');
}

function isInside(parent, candidate) {
  const root = normalized(parent);
  const path = normalized(candidate);
  return path === root || path.startsWith(`${root}/`);
}

/**
 * @param ctx - the Host plugin context.
 * @param {{ root?: string, scratchRoot?: string }} config - row config; `root` is a test-only override.
 */
export async function apply(ctx, config = {}) {
  const root = config.root ?? resolveScratchRoot(config.scratchRoot);
  await mkdir(root, { recursive: true });

  // The one Workspace that collects every no-project session. Keeping a single
  // registration is what makes the sidebar show one "最近" list instead of one
  // section per conversation.
  let workspace = await ctx.workspaceRegistry.resolveByPath(root);
  if (workspace === undefined) {
    workspace = await ctx.workspaceRegistry.create(root, SCRATCH_TITLE);
  }

  // A previous `scratchRoot` leaves its own "最近" row behind; two identical
  // sections would make it ambiguous where a new session lands. Directories and
  // session logs are retained — only the grouping goes away.
  for (const stale of ctx.workspaceRegistry.list()) {
    if (stale.id === workspace.id) continue;
    if (stale.title !== SCRATCH_TITLE) continue;
    if (normalized(stale.path) === normalized(root)) continue;
    try {
      await ctx.workspaceRegistry.delete(stale.id);
    } catch (error) {
      ctx.logger.warn(`no-project sessions: could not retire ${stale.path}: ${String(error)}`);
    }
  }

  // Keep the synthetic section after real projects in the sidebar order.
  const order = ctx.workspaceRegistry.list().map((item) => item.id);
  if (order.at(-1) !== workspace.id) await ctx.workspaceRegistry.insertBefore(workspace.id);

  // The Client's in-flight cache is local to one browser; serialize the whole
  // reservation + durable commit here so all browsers share one preparation.
  // Keep only pending work: failed commits can retry, and sessions stay
  // independent.
  const prepareInFlight = new Map();

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PREPARE_PATH,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) {
        res.statusCode = rejection;
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        res.statusCode = 405;
        res.end();
        return;
      }
      try {
        const body = await readJson(req);
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        const text = typeof body.text === 'string' ? body.text : '';
        const agent = ctx.agents.get(sessionId);
        if (agent === undefined) {
          sendJson(res, 409, { error: '会话尚未就绪，请稍后再试。' });
          return;
        }
        const header = agent.session.header;
        if (header.cwd === undefined || normalized(header.cwd) !== normalized(root)) {
          sendJson(res, 400, { error: '该会话不是无项目会话。' });
          return;
        }

        // The Host owns idempotency: a session that already works inside the
        // root keeps its directory, so the Client may call this on every send.
        const current = ctx.workingDirectory.get(agent.session);
        if (current !== root && isInside(root, current)) {
          sendJson(res, 200, { path: current, reused: true });
          return;
        }

        let pending = prepareInFlight.get(sessionId);
        if (pending === undefined) {
          pending = (async () => {
            const dateDirectory = join(root, localDate(header.createdAt));
            await mkdir(dateDirectory, { recursive: true });
            const target = await reserveDirectory(dateDirectory, directoryNameFromMessage(text));
            try {
              // Committing a different working directory is what makes the Host
              // inject its "working directory changed" notice into the session.
              await ctx.workingDirectory.set(agent, target);
            } catch (error) {
              // Do not leave a reserved but unbound folder behind when the
              // durable working-directory commit itself fails.
              await rmdir(target).catch(() => {});
              throw error;
            }
            return target;
          })();
          prepareInFlight.set(sessionId, pending);
          const clearPending = () => {
            if (prepareInFlight.get(sessionId) === pending) prepareInFlight.delete(sessionId);
          };
          pending.then(clearPending, clearPending);
        }
        const target = await pending;
        sendJson(res, 200, { path: target });
      } catch (error) {
        ctx.logger.warn(`no-project sessions: prepare failed: ${String(error)}`);
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  }), 'no-project-sessions: POST /dsh-no-project/prepare');

  // The bundle's own settings page reads the effective root and writes a new one
  // once. Writing an ordinary config field restarts this row, so `apply` re-runs
  // and later sessions are created under the new directory.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONFIG_PATH,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== undefined) {
        res.statusCode = rejection;
        res.end();
        return;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, {
          root,
          workspaceId: workspace.id,
          configured: typeof config.scratchRoot === 'string' && config.scratchRoot.trim() !== '',
        });
        return;
      }
      if (req.method !== 'POST') {
        res.setHeader('allow', 'GET, POST');
        res.statusCode = 405;
        res.end();
        return;
      }
      try {
        const body = await readJson(req);
        const requested = typeof body.root === 'string' ? body.root.trim() : '';
        const entry = ctx.fiber?.entry;
        const editor = ctx.get('configEditor');
        if (entry === undefined || editor === undefined) {
          sendJson(res, 501, { error: '当前 profile 无法保存插件配置。' });
          return;
        }
        // An empty value clears the field so the built-in default applies again.
        const next = requested === '' ? undefined : resolveScratchRoot(requested);
        if (next !== undefined) await mkdir(next, { recursive: true });
        await editor.edit(entry, (current) => {
          const { scratchRoot: _ignored, ...rest } = current;
          return next === undefined ? rest : { ...rest, scratchRoot: next };
        });
        sendJson(res, 200, { root: next ?? defaultScratchRoot(), restart: true });
      } catch (error) {
        ctx.logger.warn(`no-project sessions: save failed: ${String(error)}`);
        sendJson(res, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  }), 'no-project-sessions: /dsh-no-project/config');
}
