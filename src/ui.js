// Output, errors, prompts and small text helpers shared by every command.
import pc from 'picocolors';
import * as clack from '@clack/prompts';
import { homedir } from 'node:os';

/** An expected, user-facing failure. Printed without a stack trace. */
export class SkmError extends Error {
  /**
   * @param {string} message
   * @param {{hint?: string|string[], exitCode?: number}} [opts]
   */
  constructor(message, { hint, exitCode = 1 } = {}) {
    super(message);
    this.name = 'SkmError';
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

export const sym = {
  ok: pc.green('✔'),
  err: pc.red('✖'),
  warn: pc.yellow('▲'),
  info: pc.cyan('ℹ'),
  dry: pc.magenta('○'),
  arrow: pc.dim('→'),
};

export const out = {
  log: (...a) => console.log(...a),
  success: (msg) => console.log(`${sym.ok} ${msg}`),
  info: (msg) => console.log(`${sym.info} ${msg}`),
  warn: (msg) => console.error(`${sym.warn} ${pc.yellow(msg)}`),
  error: (msg) => console.error(`${sym.err} ${pc.red(msg)}`),
  dry: (msg) => console.log(`${sym.dry} ${pc.magenta('[dry run]')} ${msg}`),
  hint: (msg) => console.error(`  ${pc.dim(msg)}`),
  blank: () => console.log(),
};

export function printError(err) {
  if (err instanceof SkmError) {
    out.error(err.message);
    const hints = Array.isArray(err.hint) ? err.hint : err.hint ? [err.hint] : [];
    for (const h of hints) out.hint(h);
    return err.exitCode;
  }
  out.error(err?.message || String(err));
  if (process.env.SKM_DEBUG) console.error(err?.stack);
  else out.hint('Set SKM_DEBUG=1 for a stack trace.');
  return 1;
}

/** True when we may ask the user questions. */
export function isInteractive() {
  if (process.env.SKM_NO_INPUT || process.env.CI) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function unwrap(v) {
  if (clack.isCancel(v)) {
    clack.cancel('Cancelled.');
    throw new SkmError('Cancelled.', { exitCode: 130 });
  }
  return v;
}

export const prompt = {
  async confirm(message, initialValue = false) {
    return unwrap(await clack.confirm({ message, initialValue }));
  },
  async select(message, options, initialValue) {
    return unwrap(await clack.select({ message, options, initialValue, maxItems: 12 }));
  },
  async multiselect(message, options, initialValues = [], required = false) {
    return unwrap(await clack.multiselect({ message, options, initialValues, required, maxItems: 14 }));
  },
  async text(message, { placeholder, initialValue, validate } = {}) {
    return unwrap(await clack.text({ message, placeholder, initialValue, validate }));
  },
};
export { clack };

/** Replace $HOME with ~ for display. */
export function tildify(p) {
  const home = process.env.HOME || homedir();
  if (!p) return p;
  if (p === home) return '~';
  const cwd = process.cwd();
  if (cwd !== home && cwd !== '/' && p.startsWith(cwd + '/')) return '.' + p.slice(cwd.length);
  return p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

const ANSI = /\x1b\[[0-9;]*m/g;
export const visibleLength = (s) => String(s).replace(ANSI, '').length;

export function truncate(s, max) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (max <= 1) return s.slice(0, Math.max(0, max));
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * Render a simple aligned table. The last column absorbs the remaining width.
 * @param {string[]} headers
 * @param {string[][]} rows  cells may contain ANSI colors (except the last column, which is truncated raw)
 * @param {{lastRaw?: (row: number) => string, lastColor?: (s: string, row: number) => string}} [opts]
 */
export function table(headers, rows, opts = {}) {
  const width = process.stdout.columns || 120;
  const n = headers.length;
  const widths = headers.map((h, i) =>
    i === n - 1 ? 0 : Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i]))),
  );
  const gap = 2;
  const used = widths.slice(0, n - 1).reduce((a, b) => a + b + gap, 0);
  const lastWidth = Math.max(20, width - used - 1);
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - visibleLength(s)));
  const line = (cells, isHeader, rowIdx) =>
    cells
      .map((c, i) => {
        if (i < n - 1) return pad(c, widths[i]);
        const raw = isHeader ? c : truncate(opts.lastRaw ? opts.lastRaw(rowIdx) : c, lastWidth);
        return isHeader ? c : opts.lastColor ? opts.lastColor(raw, rowIdx) : raw;
      })
      .join(' '.repeat(gap))
      .trimEnd();
  const lines = [pc.bold(pc.dim(line(headers, true)))];
  rows.forEach((r, idx) => lines.push(line(r, false, idx)));
  return lines.join('\n');
}

export function levenshtein(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Up to 3 close matches for a mistyped name. */
export function didYouMean(input, candidates) {
  const uniq = [...new Set(candidates)];
  const lower = input.toLowerCase();
  const scored = uniq
    .map((c) => {
      const cl = c.toLowerCase();
      let d = levenshtein(input, c);
      if (cl.includes(lower) || lower.includes(cl)) d = Math.min(d, 1);
      return { c, d };
    })
    .filter(({ c, d }) => d <= Math.max(2, Math.floor(c.length / 3)))
    .sort((x, y) => x.d - y.d || x.c.localeCompare(y.c));
  return scored.slice(0, 3).map((s) => s.c);
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const scopeColor = (scope) =>
  scope === 'user' ? pc.cyan(scope) : scope === 'project' ? pc.magenta(scope) : pc.blue(scope);

export const plural = (n, word, pluralWord = word + 's') => `${n} ${n === 1 ? word : pluralWord}`;
