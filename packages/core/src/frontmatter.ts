/**
 * A deliberately small YAML-frontmatter reader.
 *
 * Claude Code's agents, skills and commands use a flat frontmatter block —
 * scalars, inline `[a, b]` lists, and block lists. That is all this parses. It
 * exists so Pebble can inventory those files without taking a YAML dependency,
 * and it reports what it could not understand rather than guessing.
 */

export interface Frontmatter {
  data: Record<string, string | string[] | boolean | number>;
  body: string;
  /** True when the file opened with a `---` fence at all. */
  present: boolean;
}

function coerce(raw: string): string | string[] | boolean | number {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && !Number.isNaN(Number(value)) && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((part) => unquote(part.trim()))
      .filter((part) => part.length > 0);
  }
  return unquote(value);
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
  }
  return value;
}

export function parseFrontmatter(content: string): Frontmatter {
  const normalized = content.startsWith('﻿') ? content.slice(1) : content;
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { data: {}, body: normalized, present: false };

  const data: Record<string, string | string[] | boolean | number> = {};
  let end = -1;
  let pendingKey: string | null = null;
  let pendingList: string[] = [];

  const flush = (): void => {
    if (pendingKey && pendingList.length > 0) data[pendingKey] = pendingList;
    pendingKey = null;
    pendingList = [];
  };

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '---') {
      end = i;
      break;
    }
    // Block-list continuation: "  - value"
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && pendingKey) {
      pendingList.push(unquote((listItem[1] ?? '').trim()));
      continue;
    }
    const pair = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    flush();
    const key = pair[1] ?? '';
    const rest = pair[2] ?? '';
    if (rest.trim() === '') {
      pendingKey = key;
      continue;
    }
    data[key] = coerce(rest);
  }
  flush();

  if (end === -1) return { data: {}, body: normalized, present: false };
  return { data, body: lines.slice(end + 1).join('\n'), present: true };
}

export function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.join(', ');
  return null;
}
