import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { expandHome } from '../paths.ts';
import { ORG_FILE, type OrgRootSource } from './read.ts';

export interface OrgRootResolution {
  root: string;
  source: OrgRootSource;
}

export interface ResolveOrgRootOptions {
  /** An explicit `--org` value: the root directory, or org.json itself. */
  flag?: string | null;
  /** Defaults to `process.env.PEBBLE_ORG_ROOT`. */
  env?: string | null;
  /** Where discovery starts. Defaults to `process.cwd()`. */
  cwd?: string;
  /** The last-resort location. Defaults to `~/Development`. */
  fallback?: string;
}

function hasOrgFile(dir: string): boolean {
  try {
    return statSync(join(dir, ORG_FILE)).isFile();
  } catch {
    return false;
  }
}

/** Accepts a directory or a path to org.json itself, so `--org ~/Development/org.json` works too. */
function asRoot(value: string): string {
  const path = expandHome(value.trim());
  return basename(path) === ORG_FILE ? dirname(path) : path;
}

/**
 * Where the org lives: an explicit flag, then `PEBBLE_ORG_ROOT`, then the
 * nearest ancestor of the working directory holding an org.json, then
 * `~/Development`. An explicit choice is honoured even when it holds no
 * org.json — silently falling through to somewhere else would show the wrong
 * org with a straight face. `loadOrg` reports the absence instead.
 */
export function resolveOrgRoot(options: ResolveOrgRootOptions = {}): OrgRootResolution {
  if (options.flag && options.flag.trim() !== '') return { root: asRoot(options.flag), source: 'flag' };

  const env = options.env === undefined ? process.env.PEBBLE_ORG_ROOT : options.env;
  if (env && env.trim() !== '') return { root: asRoot(env), source: 'env' };

  let dir = resolve(options.cwd ?? process.cwd());
  for (;;) {
    if (hasOrgFile(dir)) return { root: dir, source: 'discovered' };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return { root: resolve(options.fallback ?? join(homedir(), 'Development')), source: 'default' };
}
