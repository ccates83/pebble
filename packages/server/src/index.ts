import { serve } from '@hono/node-server';

import {
  AdapterRegistry,
  IndexLoop,
  Indexer,
  PebbleStore,
  orgFingerprint,
  resolveOrgRoot,
  type OrgRootResolution,
  type StatusWindows,
} from '@pebble/core';
import { createApp } from './app.ts';
import { EventBus } from './events.ts';

export interface ServeOptions {
  port?: number;
  /** Loopback by default: this is personal data and there is no auth. */
  host?: string;
  dbPath?: string;
  webRoot?: string;
  pollMs?: number;
  windows?: StatusWindows;
  /** `--org`: the org root (or its org.json). Falls back to env, discovery, then ~/Development. */
  orgRoot?: string;
  onListen?: (info: { host: string; port: number; url: string }) => void;
  onIndex?: (updated: number, durationMs: number) => void;
  onError?: (error: Error) => void;
}

export interface RunningServer {
  url: string;
  port: number;
  store: PebbleStore;
  org: OrgRootResolution;
  close(): Promise<void>;
}

export const DEFAULT_PORT = 7777;

export async function startServer(options: ServeOptions = {}): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? DEFAULT_PORT;

  const store = options.dbPath ? new PebbleStore(options.dbPath) : new PebbleStore();
  const registry = new AdapterRegistry();
  const indexer = new Indexer(registry, store);
  const bus = new EventBus();
  const org = resolveOrgRoot({ flag: options.orgRoot });

  const app = createApp({ store, registry, indexer, bus, webRoot: options.webRoot, org, startedAt: new Date() });

  // The org is not indexed, so the index loop cannot say when it changed. A
  // stat-only fingerprint each tick can: when it moves, dashboards re-fetch.
  // The first reading is the baseline and announces nothing.
  let orgPrint: string | null = null;
  let orgChecking = false;
  const checkOrg = async (): Promise<void> => {
    if (orgChecking) return;
    orgChecking = true;
    try {
      const next = await orgFingerprint(org.root);
      if (orgPrint !== null && next !== orgPrint) bus.publish({ type: 'org', at: new Date().toISOString() });
      orgPrint = next;
    } catch (error) {
      options.onError?.(error as Error);
    } finally {
      orgChecking = false;
    }
  };

  const loop = new IndexLoop(indexer, {
    intervalMs: options.pollMs ?? 2_000,
    windows: options.windows,
    onResult: (result) => {
      // Only speak up when something actually changed — a quiet loop should be
      // silent, or the SSE stream becomes noise and the log becomes unreadable.
      if (result.updated > 0) {
        bus.publish({
          type: 'index',
          updated: result.updated,
          durationMs: result.durationMs,
          at: new Date().toISOString(),
        });
        options.onIndex?.(result.updated, result.durationMs);
      }
      void checkOrg();
    },
    onError: (error) => {
      options.onError?.(error);
      // A failed index pass says nothing about the org; keep watching it.
      void checkOrg();
    },
  });

  const server = serve({ fetch: app.fetch, hostname: host, port });
  loop.start();

  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
  options.onListen?.({ host, port, url });

  return {
    url,
    port,
    store,
    org,
    async close() {
      loop.stop();
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      });
      store.close();
    },
  };
}

export { createApp } from './app.ts';
export { EventBus } from './events.ts';
export type { PebbleEvent } from './events.ts';
export type { AppDeps } from './app.ts';
