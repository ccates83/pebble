/** Terminal formatting helpers. Colour is dropped when output is piped. */
const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

const wrap = (code: string) => (text: string): string => (useColor ? `\u001B[${code}m${text}\u001B[0m` : text);

export const dim = wrap('2');
export const bold = wrap('1');
export const red = wrap('31');
export const yellow = wrap('33');
export const green = wrap('32');
export const cyan = wrap('36');

export function money(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function compactNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '—';
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return `${Math.max(seconds, 0)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Marks a figure whose provenance is anything less than exact, so an estimate is
 * never printed as though it were measured.
 */
export function costLabel(usd: number, basis: string, hasConflict: boolean): string {
  const base = money(usd);
  if (hasConflict) return `${base}${yellow('*')}`;
  if (basis === 'estimated') return `${base}${yellow('~')}`;
  if (basis === 'partial') return `${base}${red('?')}`;
  return base;
}

export function table(rows: string[][], options: { head?: string[] } = {}): string {
  const all = options.head ? [options.head, ...rows] : rows;
  if (all.length === 0) return '';
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell));
    });
  }
  const render = (row: string[]): string =>
    row.map((cell, i) => pad(cell, widths[i] ?? 0, i === row.length - 1)).join('  ').trimEnd();
  const lines: string[] = [];
  if (options.head) {
    lines.push(dim(render(options.head)));
  }
  for (const row of rows) lines.push(render(row));
  return lines.join('\n');
}

function visibleLength(text: string): number {
  return text.replace(/\u001B\[[0-9;]*m/g, '').length;
}

function pad(text: string, width: number, last: boolean): string {
  if (last) return text;
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

export function statusMark(status: string): string {
  switch (status) {
    case 'active':
      return green('● active ');
    case 'waiting':
      return yellow('◐ waiting');
    case 'idle':
      return cyan('○ idle   ');
    default:
      return dim('· done   ');
  }
}
