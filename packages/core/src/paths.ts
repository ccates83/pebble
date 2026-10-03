import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/** Expands a leading `~` and makes the path absolute. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/** Where Pebble keeps its own derived index. Always rebuildable; never authoritative. */
export function pebbleDataDir(): string {
  const override = process.env.PEBBLE_DATA_DIR;
  return override ? expandHome(override) : resolve(homedir(), '.pebble');
}
