import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveIn } from './fs.ts';
import { ORG_FILE } from './read.ts';

/** The folders whose contents drive attention items. */
const WATCHED_DIRS = ['07 System/Approvals', '00 Inbox', '06 Self Improvements', '08 Reviews'];

async function statSig(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${Math.floor(info.mtimeMs)}:${info.size}`;
  } catch {
    return '-';
  }
}

/**
 * Directory mtime catches a note added or removed; the per-file stats catch an
 * in-place edit (an approval flipping to `approved`), which leaves the
 * directory's mtime alone.
 */
async function dirSig(dir: string): Promise<string> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return '-';
  }
  const parts = [await statSig(dir)];
  for (const name of names) parts.push(`${name}=${await statSig(join(dir, name))}`);
  return parts.join(',');
}

/**
 * A cheap, stat-only signature of the parts of the org the HQ view depends on.
 * When it changes, the server tells open dashboards to re-fetch. It reads
 * org.json (a few kilobytes) to know which vaults to stat and nothing else —
 * no note is opened. Never throws; anything unreadable just contributes `-`.
 */
export async function orgFingerprint(root: string): Promise<string> {
  const orgFile = join(root, ORG_FILE);
  const parts = [`org=${await statSig(orgFile)}`];

  const vaults: string[] = [];
  try {
    const parsed = JSON.parse(await readFile(orgFile, 'utf8')) as Record<string, unknown>;
    const holding = parsed.holding as Record<string, unknown> | undefined;
    vaults.push(resolveIn(root, holding?.hq) ?? join(root, 'HQ'));
    for (const sub of Array.isArray(parsed.subsidiaries) ? parsed.subsidiaries : []) {
      const obj = sub as Record<string, unknown> | null;
      const path = obj ? (resolveIn(root, obj.vault) ?? resolveIn(root, obj.path)) : null;
      if (path) vaults.push(path);
    }
  } catch {
    vaults.push(join(root, 'HQ'));
  }

  for (const vault of vaults) {
    for (const dir of WATCHED_DIRS) parts.push(`${vault}/${dir}=${await dirSig(join(vault, dir))}`);
    parts.push(`${vault}/changelog=${await statSig(join(vault, '07 System', 'Logs', 'CHANGELOG.md'))}`);
    parts.push(`${vault}/charter=${await statSig(join(vault, 'Charter.md'))}`);
  }
  return parts.join('\n');
}
