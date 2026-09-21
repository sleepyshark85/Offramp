// Small shared reporting helpers for the harnesses.

export function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[i];
}

export function summary(values) {
  const s = values.slice().sort((a, b) => a - b);
  return {
    sorted: s,
    n: s.length,
    min: s[0],
    median: percentile(s, 0.5),
    p95: percentile(s, 0.95),
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / (s.length || 1),
  };
}

export function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return Number.isNaN(Number(v)) ? v : Number(v);
}

export function has(name) {
  return process.argv.includes('--' + name);
}

export function table(rows) {
  const keys = Object.keys(rows[0]);
  const w = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join('  ');
  const out = [line(keys), line(w.map((n) => '-'.repeat(n)))];
  for (const r of rows) out.push(line(keys.map((k) => r[k])));
  return out.join('\n');
}

export const PASS = 'PASS';
export const FAIL = 'FAIL';
