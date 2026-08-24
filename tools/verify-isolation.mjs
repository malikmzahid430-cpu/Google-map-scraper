/**
 * Start-button isolation verifier.
 *
 * Walks the REAL import graph from the collector entry point and fails if any
 * forbidden module is reachable. This is the mechanical enforcement of the
 * rule that broke every previous version:
 *
 *     ADDING A FEATURE MUST NEVER BREAK THE START BUTTON.
 *
 * Run: node tools/verify-isolation.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Entry points whose graphs must stay clean, and what they may not reach. */
const RULES = [
  {
    name: 'Collector (the Start button path)',
    entry: 'src/collector/collector.js',
    forbidden: [
      'src/engines/dedupe.js',
      'src/engines/score.js',
      'src/engines/validate.js',
      'src/engines/filters.js',
      'src/enrich/',
      'src/export/',
      'src/background/',
      'src/jobs/',
    ],
  },
  {
    name: 'Content script entry',
    entry: 'src/collector/index.js',
    forbidden: ['src/enrich/', 'src/export/', 'src/background/', 'src/engines/dedupe.js', 'src/engines/score.js', 'src/jobs/'],
  },
  {
    name: 'Core (must not depend on the app)',
    entry: 'src/core/constants.js',
    forbidden: ['src/collector/', 'src/engines/', 'src/enrich/', 'src/export/', 'src/jobs/', 'src/sidepanel/'],
  },
];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveSpecifier(spec, fromFile) {
  if (!spec.startsWith('.')) return null;            // bare specifier: none exist here
  const abs = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [abs, `${abs}.js`, path.join(abs, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return abs;                                         // report as missing later
}

function collectImports(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = new Set();
  for (const re of [IMPORT_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) out.add(m[1]);
  }
  return [...out];
}

function walk(entryRel) {
  const entry = path.join(ROOT, entryRel);
  const seen = new Set();
  const missing = [];
  const stack = [entry];

  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);

    if (!fs.existsSync(file)) { missing.push(file); continue; }

    for (const spec of collectImports(file)) {
      const resolved = resolveSpecifier(spec, file);
      if (!resolved) continue;
      if (!fs.existsSync(resolved)) missing.push(`${path.relative(ROOT, resolved)} (from ${path.relative(ROOT, file)})`);
      else stack.push(resolved);
    }
  }
  return { reached: [...seen].map((f) => path.relative(ROOT, f)), missing };
}

let failures = 0;
console.log('\n  Start-button isolation check\n  ' + '='.repeat(52) + '\n');

for (const rule of RULES) {
  const { reached, missing } = walk(rule.entry);
  const violations = reached.filter((f) =>
    rule.forbidden.some((bad) => (bad.endsWith('/') ? f.startsWith(bad) : f === bad)));

  const okIsolation = violations.length === 0;
  const okImports = missing.length === 0;

  console.log(`  ${okIsolation && okImports ? 'PASS' : 'FAIL'}  ${rule.name}`);
  console.log(`        entry: ${rule.entry}`);
  console.log(`        reaches ${reached.length} module(s)`);

  if (violations.length) {
    failures++;
    console.log('        FORBIDDEN DEPENDENCIES REACHED:');
    for (const v of violations) console.log(`          - ${v}`);
  }
  if (missing.length) {
    failures++;
    console.log('        BROKEN IMPORTS:');
    for (const v of missing) console.log(`          - ${v}`);
  }
  console.log('');
}

console.log('  ' + '='.repeat(52));
if (failures) {
  console.log(`  ${failures} rule(s) violated. The Start button is NOT isolated.\n`);
  process.exit(1);
}
console.log('  All isolation rules hold. Start is independent.\n');
