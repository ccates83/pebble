import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { expandHome } from '../../paths.ts';

/**
 * Claude Code's config root. Honors CLAUDE_CONFIG_DIR, which is how people
 * relocate it, and PEBBLE_CLAUDE_DIR so Pebble's own tests can point elsewhere.
 */
export function claudeRoot(): string {
  const override = process.env.PEBBLE_CLAUDE_DIR ?? process.env.CLAUDE_CONFIG_DIR;
  return override ? expandHome(override) : resolve(homedir(), '.claude');
}

export function projectsDir(root = claudeRoot()): string {
  return resolve(root, 'projects');
}

/**
 * Claude Code names each project directory after its working directory with
 * every `/` replaced by `-`. That is lossy: a path segment containing a hyphen
 * is indistinguishable from a separator, so `-Users-me-connor-cates-site` could
 * decode a dozen ways.
 *
 * So this is a *display* fallback only. The authoritative cwd is the `cwd` field
 * recorded on the transcript's own entries, which the parser prefers; this runs
 * only for a directory whose transcripts are empty or unreadable.
 */
export function decodeProjectDirName(dirName: string): string {
  if (!dirName.startsWith('-')) return dirName;
  return '/' + dirName.slice(1).split('-').join('/');
}

/** Inverse of the encoding above, for locating a known project's directory. */
export function encodeProjectPath(absPath: string): string {
  return absPath.replace(/[/\\]/g, '-');
}
