#!/usr/bin/env node
// Checks the design docs for AC numbering problems.
//   - duplicate AC definitions
//   - references to ACs that do not exist (dangling)
//   - ACs defined out of their group's numeric range
//   - gaps in numbering are NOT an error (numbers are assigned with gaps deliberately)
// Exit 0 = clean, 1 = at least one hard failure.
//
// Usage: node docs/design/check-ac-refs.mjs [--verbose]

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESIGN_DIR = dirname(fileURLToPath(import.meta.url));
const AC_FILE = 'acceptance-criteria.md';
const DEFINITION = /^\*\*AC-(\d{3})\s+·/;
const REFERENCE = /\bAC-(\d{3})\b/g;
const GROUPS = [
  [100, 199, 'Simulation'], [200, 299, 'Generation'], [300, 399, 'Input'],
  [400, 499, 'Layout'],     [500, 599, 'Visual'],     [600, 699, 'Accessibility'],
  [700, 799, 'Progression'], [800, 899, 'Failure and edge cases'],
];
const verbose = process.argv.includes('--verbose');

const mdFiles = readdirSync(DESIGN_DIR).filter((f) => f.endsWith('.md')).sort();
if (!mdFiles.includes(AC_FILE)) {
  console.error(`FAIL  ${AC_FILE} not found in ${DESIGN_DIR}`);
  process.exit(1);
}

// 1. Collect definitions, in file order, with their enclosing group heading.
const acText = readFileSync(join(DESIGN_DIR, AC_FILE), 'utf8');
const defined = new Map();          // id -> { line, group }
const duplicates = [];
const misgrouped = [];
let currentGroup = null;

acText.split('\n').forEach((line, i) => {
  const heading = line.match(/^##\s+(\d{3})\s+—\s+(.+)$/);
  if (heading) currentGroup = Number(heading[1]);
  const def = line.match(DEFINITION);
  if (!def) return;
  const id = Number(def[1]);
  if (defined.has(id)) duplicates.push({ id, first: defined.get(id).line, again: i + 1 });
  else defined.set(id, { line: i + 1, group: currentGroup });
  const g = GROUPS.find(([lo, hi]) => id >= lo && id <= hi);
  if (!g) misgrouped.push({ id, line: i + 1, why: 'outside every declared group range' });
  else if (currentGroup !== null && currentGroup !== g[0]) {
    misgrouped.push({ id, line: i + 1, why: `defined under the ${currentGroup} heading but numbered in ${g[0]} (${g[2]})` });
  }
});

// 2. Collect references from every design doc.
const dangling = [];
const referencedBy = new Map();
for (const file of mdFiles) {
  const text = readFileSync(join(DESIGN_DIR, file), 'utf8');
  text.split('\n').forEach((line, i) => {
    if (file === AC_FILE && DEFINITION.test(line)) return;   // a definition is not a reference
    for (const m of line.matchAll(REFERENCE)) {
      const id = Number(m[1]);
      if (!defined.has(id)) dangling.push({ id, file, line: i + 1 });
      else {
        if (!referencedBy.has(id)) referencedBy.set(id, []);
        referencedBy.get(id).push(`${file}:${i + 1}`);
      }
    }
  });
}

// 3. Report.
let failures = 0;
const fail = (msg) => { failures++; console.error(`FAIL  ${msg}`); };

for (const d of duplicates) fail(`AC-${d.id} defined twice (${AC_FILE}:${d.first} and :${d.again})`);
for (const d of dangling) fail(`AC-${d.id} referenced at ${d.file}:${d.line} but never defined`);
for (const m of misgrouped) fail(`AC-${m.id} at ${AC_FILE}:${m.line} — ${m.why}`);

const ids = [...defined.keys()].sort((a, b) => a - b);
console.log(`${ids.length} acceptance criteria defined across ${GROUPS.length} groups.`);
for (const [lo, hi, name] of GROUPS) {
  const inGroup = ids.filter((id) => id >= lo && id <= hi);
  const next = inGroup.length ? Math.max(...inGroup) + 1 : lo + 1;
  console.log(
    `  ${lo}-${hi}  ${name.padEnd(22)} ${String(inGroup.length).padStart(3)} defined` +
    (inGroup.length ? `  (${inGroup[0]}–${inGroup[inGroup.length - 1]}, next free ${next})` : ''),
  );
}
const unreferenced = ids.filter((id) => !referencedBy.has(id));
console.log(`${ids.length - unreferenced.length} of ${ids.length} are cited from a design document.`);
if (verbose && unreferenced.length) console.log(`  not cited: ${unreferenced.join(', ')}`);

if (failures) { console.error(`\n${failures} failure(s).`); process.exit(1); }
console.log('\nOK — no duplicate definitions, no dangling references, no misgrouped numbers.');
