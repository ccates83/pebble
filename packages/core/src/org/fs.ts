import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import type { Issue, OrgNote } from '../types.ts';
import { asString, parseFrontmatter, type Frontmatter } from '../frontmatter.ts';

/**
 * Small, never-throwing file helpers for the org reader. Every vault here is
 * hand-edited by a person and a handful of agents, so any file can be missing,
 * half-written or not what its name suggests.
 */

/** Notes larger than this are not read; a vault note that big is not a note. */
const MAX_NOTE_BYTES = 1_000_000;

export async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Reads a UTF-8 file, or returns null and records why. A missing file is not an issue. */
export async function readText(path: string, issues: Issue[], code = 'org.read-failed'): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    if (info.size > MAX_NOTE_BYTES) {
      issues.push({ level: 'warn', code: 'org.note-too-large', message: `Skipped ${basename(path)}: ${info.size} bytes.`, path });
      return null;
    }
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    issues.push({ level: 'warn', code, message: `Could not read ${basename(path)}: ${(error as Error).message}`, path });
    return null;
  }
}

/** Resolves a path from org.json against the root, refusing anything that is not a string. */
export function resolveIn(root: string, value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return isAbsolute(value) ? resolve(value) : resolve(root, value);
}

export function rel(root: string, path: string): string {
  const r = relative(root, path);
  return r === '' ? '.' : r;
}

/** Strips `[[wikilink|alias]]` brackets and surrounding quotes from a frontmatter value. */
function clean(value: unknown): string | null {
  const s = asString(value);
  if (s === null) return null;
  // Obsidian users link rather than type: `department: "[[Sales Charter|Sales]]"`.
  const trimmed = s
    .trim()
    .replace(/^\[\[(?:[^\]|]*\|)?([^\]]*)\]\]$/, '$1')
    .trim();
  return trimmed === '' ? null : trimmed;
}

export function fmString(fm: Frontmatter, key: string): string | null {
  return clean(fm.data[key]);
}

export function fmNumber(fm: Frontmatter, key: string): number | null {
  const v = fm.data[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    // "$1,200" and "1200 USD" are what a person writes; anything else is unknown.
    const n = Number(v.replace(/[$,\s]|usd/gi, ''));
    return v.trim() !== '' && Number.isFinite(n) ? n : null;
  }
  return null;
}

export interface ReadNote {
  note: OrgNote;
  fm: Frontmatter;
  body: string;
  mtimeMs: number;
}

/** Reads one note's frontmatter. Null if the file could not be read. */
export async function readNote(root: string, path: string, issues: Issue[]): Promise<ReadNote | null> {
  const text = await readText(path, issues);
  if (text === null) return null;
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    // Vanished after the read. The content we have is still the content.
  }
  const fm = parseFrontmatter(text, { stripComments: true });
  const created = fmString(fm, 'created');
  const updated = fmString(fm, 'updated') ?? created ?? (mtimeMs > 0 ? new Date(mtimeMs).toISOString() : null);
  return {
    note: {
      path,
      relPath: rel(root, path),
      title: fmString(fm, 'title') ?? basename(path).replace(/\.md$/i, ''),
      summary: fmString(fm, 'summary'),
      status: fmString(fm, 'status'),
      updated,
      created,
    },
    fm,
    body: fm.body,
    mtimeMs,
  };
}

/** Is this file a note a person wrote, rather than vault machinery? */
function isContentNote(name: string): boolean {
  if (name.startsWith('.')) return false;
  if (!name.toLowerCase().endsWith('.md')) return false;
  if (/-INDEX\.md$/i.test(name) || name === 'INDEX.md') return false;
  return true;
}

/** Every content note directly inside `dir`. A missing directory is an empty list. */
export async function readNotesIn(
  root: string,
  dir: string,
  issues: Issue[],
  filter: (name: string) => boolean = () => true,
): Promise<ReadNote[]> {
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() || e.isSymbolicLink()).map((e) => e.name);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      issues.push({ level: 'warn', code: 'org.dir-unreadable', message: `Could not list ${basename(dir)}: ${(error as Error).message}`, path: dir });
    }
    return [];
  }
  const notes: ReadNote[] = [];
  for (const name of names.filter(isContentNote).filter(filter).sort()) {
    const read = await readNote(root, join(dir, name), issues);
    if (read) notes.push(read);
  }
  return notes;
}

/** A sortable instant for a frontmatter date or ISO timestamp; 0 when unparseable. */
export function dateMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/** Newest first by `created`, then `updated`, then mtime; name breaks ties for a stable order. */
export function newestFirst(a: ReadNote, b: ReadNote): number {
  const key = (n: ReadNote): number => dateMs(n.note.created) || dateMs(n.note.updated) || n.mtimeMs;
  return key(b) - key(a) || b.note.path.localeCompare(a.note.path);
}
