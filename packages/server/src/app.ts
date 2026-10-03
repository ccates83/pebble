import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { Hono } from 'hono';
import type { Context } from 'hono';

import {
  AdapterRegistry,
  Indexer,
  PebbleStore,
  buildHqOverview,
  loadOrg,
  runDoctor,
  type OrgRootResolution,
  type ConfigSurface,
  type SessionFilter,
  type SessionStatus,
} from '@pebble/core';
import type { EventBus } from './events.ts';

export interface AppDeps {
  store: PebbleStore;
  registry: AdapterRegistry;
  indexer: Indexer;
  bus: EventBus;
  /** Built web assets to serve. Omit to run API-only. */
  webRoot?: string;
  /** Where the org lives. Resolved once at startup; the org itself is read per request. */
  org: OrgRootResolution;
  startedAt: Date;
}

const STATUSES: SessionStatus[] = ['active', 'waiting', 'idle', 'done'];

function parseStatuses(raw: string | undefined): SessionStatus[] | undefined {
  if (!raw) return undefined;
  const wanted = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is SessionStatus => (STATUSES as string[]).includes(s));
  return wanted.length > 0 ? wanted : undefined;
}

function intParam(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Config surfaces are the slowest thing Pebble does — a few hundred stats across
 * every project — so they are cached and refreshed on demand rather than on a
 * timer. Nothing here changes under you without an explicit refresh.
 */
class ConfigCache {
  private value: ConfigSurface[] | null = null;
  private pending: Promise<ConfigSurface[]> | null = null;

  constructor(
    private readonly registry: AdapterRegistry,
    private readonly store: PebbleStore,
  ) {}

  async get(force = false): Promise<ConfigSurface[]> {
    if (!force && this.value) return this.value;
    if (this.pending) return this.pending;
    this.pending = this.scan()
      .then((surfaces) => {
        this.value = surfaces;
        return surfaces;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  private async scan(): Promise<ConfigSurface[]> {
    const projectPaths = this.store.projectPaths();
    const surfaces: ConfigSurface[] = [];
    for (const adapter of this.registry.all()) {
      surfaces.push(await adapter.scanConfig({ projectPaths }));
    }
    return surfaces;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const config = new ConfigCache(deps.registry, deps.store);

  app.use('*', async (c, next) => {
    // Pebble binds to loopback and holds local session metadata. Keeping it
    // same-origin-only means a page you visit in another tab cannot read it.
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    await next();
  });

  // ---- API ---------------------------------------------------------------

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      startedAt: deps.startedAt.toISOString(),
      uptimeSec: Math.round((Date.now() - deps.startedAt.getTime()) / 1000),
      subscribers: deps.bus.size,
    }),
  );

  app.get('/api/overview', async (c) => {
    const stats = deps.store.stats();
    const live = deps.store.listSessions({ status: ['active', 'waiting'], limit: 50 });
    const recent = deps.store.listSessions({ limit: 12 });
    const adapters = await Promise.all(
      deps.registry.all().map(async (adapter) => ({
        id: adapter.id,
        label: adapter.label,
        kind: adapter.kind,
        ...(await adapter.detect()),
      })),
    );
    return c.json({
      stats,
      live,
      recent,
      adapters,
      projects: deps.store.projectRollup().slice(0, 12),
      daily: deps.store.dailyCost(30),
    });
  });

  // Read fresh on every request: it is a few dozen small files, and a cached
  // copy would show an approval as pending after Connor has decided it.
  app.get('/api/hq', async (c) => {
    const load = await loadOrg(deps.org);
    return c.json(buildHqOverview(deps.store, load.org, Date.now(), load));
  });

  app.get('/api/sessions', (c) => {
    const filter: SessionFilter = {
      status: parseStatuses(c.req.query('status')),
      project: c.req.query('project') || undefined,
      model: c.req.query('model') || undefined,
      search: c.req.query('q') || undefined,
      since: c.req.query('since') || undefined,
      adapter: c.req.query('adapter') || undefined,
      limit: intParam(c.req.query('limit'), 200),
      offset: intParam(c.req.query('offset'), 0),
    };
    return c.json({
      sessions: deps.store.listSessions(filter),
      total: deps.store.countSessions({ ...filter, limit: undefined, offset: undefined }),
      filter,
    });
  });

  app.get('/api/sessions/:adapter/:id', async (c) => {
    const adapterId = c.req.param('adapter');
    const adapter = deps.registry.get(adapterId);
    if (!adapter) return c.json({ error: `Unknown adapter "${adapterId}".` }, 404);
    const detail = await adapter.readSession(c.req.param('id'));
    if (!detail) return c.json({ error: 'Session not found.' }, 404);
    return c.json(detail);
  });

  app.get('/api/analytics', (c) => {
    const days = intParam(c.req.query('days'), 30);
    return c.json({
      daily: deps.store.dailyCost(days),
      projects: deps.store.projectRollup(),
      models: deps.store.modelRollup(),
      tools: deps.store.toolRollup(30),
      stats: deps.store.stats(),
    });
  });

  app.get('/api/config', async (c) => {
    const surfaces = await config.get(c.req.query('refresh') === '1');
    return c.json({ surfaces });
  });

  app.post('/api/config/refresh', async (c) => {
    const surfaces = await config.get(true);
    return c.json({ surfaces });
  });

  app.get('/api/doctor', async (c) => {
    const surfaces = await config.get(c.req.query('refresh') === '1');
    return c.json(await runDoctor(deps.registry, deps.store, surfaces));
  });

  app.post('/api/index', async (c) => {
    const force = c.req.query('force') === '1';
    const result = await deps.indexer.indexAll({ force });
    deps.bus.publish({ type: 'index', updated: result.updated, durationMs: result.durationMs, at: new Date().toISOString() });
    return c.json(result);
  });

  // Server-sent events: one line per index pass that changed something.
  app.get('/api/stream', (c) => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: unknown): void => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            // Client went away mid-write; unsubscribe below handles it.
          }
        };
        send({ type: 'hello', at: new Date().toISOString() });
        const unsubscribe = deps.bus.subscribe(send);
        // Proxies and browsers drop an idle event stream; this keeps it warm.
        const keepAlive = setInterval(() => send({ type: 'ping', at: new Date().toISOString() }), 25_000);
        keepAlive.unref?.();
        c.req.raw.signal.addEventListener('abort', () => {
          clearInterval(keepAlive);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        });
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  });

  app.all('/api/*', (c) => c.json({ error: 'No such endpoint.' }, 404));

  // ---- static web app ----------------------------------------------------

  if (deps.webRoot) {
    const root = resolve(deps.webRoot);
    const serveFile = async (c: Context, requestPath: string): Promise<Response> => {
      // Join then verify containment: a `..` in the URL must not escape webRoot.
      const target = resolve(root, `.${normalize(`/${requestPath}`)}`);
      if (target !== root && !target.startsWith(root + sep)) return c.text('Not found', 404);
      try {
        const body = await readFile(target);
        const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
        const immutable = target.includes(`${sep}assets${sep}`);
        return new Response(new Uint8Array(body), {
          headers: {
            'Content-Type': type,
            'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
          },
        });
      } catch {
        return c.text('Not found', 404);
      }
    };

    app.get('/', (c) => serveFile(c, 'index.html'));
    app.get('*', async (c) => {
      const path = new URL(c.req.url).pathname;
      const direct = await serveFile(c, path);
      if (direct.status !== 404) return direct;
      // Client-side routes fall through to the shell.
      return serveFile(c, 'index.html');
    });
  } else {
    app.get('/', (c) =>
      c.text('Pebble API is running. The dashboard was not built — run `pnpm build` and restart.', 200),
    );
  }

  return app;
}

export { join as joinPath };
