/**
 * Build integrity checks: syntax, imports, manifest, asset references.
 * Run: node tools/verify-build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

function walkDir(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walkDir(full, out);
    else out.push(full);
  }
  return out;
}

const allFiles = walkDir(path.join(ROOT, 'src'));
const jsFiles = allFiles.filter((f) => f.endsWith('.js'));

/* -------------------------- 1. syntax -------------------------- */
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    problems.push(`SYNTAX  ${path.relative(ROOT, file)}\n        ${String(err.stderr || err).split('\n').slice(0, 3).join('\n        ')}`);
  }
}
notes.push(`syntax-checked ${jsFiles.length} JS file(s)`);

/* ------------------------- 2. imports -------------------------- */
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
let importCount = 0;

for (const file of jsFiles) {
  const src = fs.readFileSync(file, 'utf8');
  for (const re of [IMPORT_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const spec = m[1];
      importCount++;
      if (!spec.startsWith('.')) {
        problems.push(`BARE IMPORT  ${path.relative(ROOT, file)} -> "${spec}" (no bundler; only relative paths resolve)`);
        continue;
      }
      const abs = path.resolve(path.dirname(file), spec);
      const found = [abs, `${abs}.js`, path.join(abs, 'index.js')].some(
        (c) => fs.existsSync(c) && fs.statSync(c).isFile());
      if (!found) problems.push(`MISSING IMPORT  ${path.relative(ROOT, file)} -> "${spec}"`);
    }
  }
}
notes.push(`resolved ${importCount} import specifier(s)`);

/* --------------- 3. exports actually exist --------------------- */
const NAMED_RE = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
for (const file of jsFiles) {
  const src = fs.readFileSync(file, 'utf8');
  NAMED_RE.lastIndex = 0;
  let m;
  while ((m = NAMED_RE.exec(src)) !== null) {
    const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    const abs = path.resolve(path.dirname(file), m[2]);
    const target = [abs, `${abs}.js`, path.join(abs, 'index.js')].find(
      (c) => fs.existsSync(c) && fs.statSync(c).isFile());
    if (!target) continue;
    const targetSrc = fs.readFileSync(target, 'utf8');
    for (const name of names) {
      // Identifiers such as $ and $$ are regex metacharacters, so the name
      // must be escaped before it goes into a pattern.
      const q = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const edge = '(?![\\w$])';
      const patterns = [
        new RegExp('export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+' + q + edge),
        new RegExp('export\\s*\\{[^}]*' + q + edge),
        new RegExp('export\\s+\\{[^}]*as\\s+' + q + edge),
      ];
      if (!patterns.some((pat) => pat.test(targetSrc))) {
        problems.push(`MISSING EXPORT  ${path.relative(ROOT, target)} does not export "${name}" (imported by ${path.relative(ROOT, file)})`);
      }
    }
  }
}

/* ------------------------- 4. manifest ------------------------- */
const manifestPath = path.join(ROOT, 'manifest.json');
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (err) {
  problems.push(`MANIFEST  invalid JSON: ${err.message}`);
}

if (manifest) {
  const mustExist = [];
  if (manifest.background && manifest.background.service_worker) mustExist.push(manifest.background.service_worker);
  if (manifest.side_panel && manifest.side_panel.default_path) mustExist.push(manifest.side_panel.default_path);
  for (const cs of manifest.content_scripts || []) mustExist.push(...(cs.js || []), ...(cs.css || []));
  for (const p of Object.values(manifest.icons || {})) mustExist.push(p);
  for (const p of Object.values((manifest.action && manifest.action.default_icon) || {})) mustExist.push(p);

  for (const rel of mustExist) {
    if (!fs.existsSync(path.join(ROOT, rel))) problems.push(`MANIFEST  references missing file: ${rel}`);
  }

  if (manifest.manifest_version !== 3) problems.push('MANIFEST  manifest_version must be 3');
  if (manifest.background && manifest.background.type !== 'module') {
    problems.push('MANIFEST  background.type must be "module" for ES imports');
  }

  // The content script is a classic script that dynamic-imports the module
  // graph, so the module files must be web-accessible.
  // --- match-pattern syntax -----------------------------------------
  // Chrome accepts "*" only as the WHOLE host or as a leading "*." subdomain
  // wildcard. A wildcard inside the host — a TLD wildcard, for instance — is
  // rejected with "Invalid host wildcard" and the ENTIRE extension fails to
  // load. So every pattern is validated here rather than at install time.
  // (Written with line comments on purpose: a match pattern ending in a
  // wildcard path would close a block comment early.)
  const SCHEMES = ['http', 'https', 'file', 'ftp', 'urn', 'ws', 'wss', '*'];

  function badMatchPattern(pattern) {
    if (pattern === '<all_urls>') return null;

    const schemeSplit = pattern.indexOf('://');
    if (schemeSplit < 0) return 'missing scheme separator "://"';

    const scheme = pattern.slice(0, schemeSplit);
    if (!SCHEMES.includes(scheme)) return `unsupported scheme "${scheme}"`;

    const rest = pattern.slice(schemeSplit + 3);
    const slash = rest.indexOf('/');
    if (slash < 0) return 'missing path (a match pattern must end with a path, e.g. /*)';

    const host = rest.slice(0, slash);
    if (scheme !== 'file' && !host) return 'missing host';

    if (host && host !== '*') {
      if (host.includes('*')) {
        // The only legal wildcard host form is a leading "*." label.
        if (!host.startsWith('*.')) return `invalid host wildcard in "${host}" — "*" may only lead as "*."`;
        if (host.slice(2).includes('*')) return `invalid host wildcard in "${host}" — only one leading "*." is allowed`;
      }
      if (host.endsWith('.')) return `host "${host}" must not end with a dot`;
    }
    return null;
  }

  const patternSources = [];
  (manifest.content_scripts || []).forEach((cs, i) => {
    (cs.matches || []).forEach((m, j) => patternSources.push([`content_scripts[${i}].matches[${j}]`, m]));
    (cs.exclude_matches || []).forEach((m, j) => patternSources.push([`content_scripts[${i}].exclude_matches[${j}]`, m]));
  });
  (manifest.host_permissions || []).forEach((m, i) => patternSources.push([`host_permissions[${i}]`, m]));
  (manifest.optional_host_permissions || []).forEach((m, i) => patternSources.push([`optional_host_permissions[${i}]`, m]));
  (manifest.web_accessible_resources || []).forEach((r, i) => {
    (r.matches || []).forEach((m, j) => patternSources.push([`web_accessible_resources[${i}].matches[${j}]`, m]));
  });

  for (const [where, pattern] of patternSources) {
    const bad = badMatchPattern(pattern);
    if (bad) problems.push(`MANIFEST  ${where} = "${pattern}" -> ${bad}`);
  }
  notes.push(`validated ${patternSources.length} match pattern(s)`);

  /* --- content scripts must be able to import their modules --------- */
  const csMatches = new Set((manifest.content_scripts || []).flatMap((cs) => cs.matches || []));
  const warMatches = new Set((manifest.web_accessible_resources || []).flatMap((r) => r.matches || []));
  const hostOf = (p) => {
    const i = p.indexOf('://');
    if (i < 0) return p;
    const rest = p.slice(i + 3);
    const slash = rest.indexOf('/');
    return slash < 0 ? rest : rest.slice(0, slash);
  };
  const warHosts = new Set([...warMatches].map(hostOf));
  for (const m of csMatches) {
    if (!warHosts.has(hostOf(m))) {
      problems.push(`MANIFEST  content script runs on "${m}" but web_accessible_resources does not cover host "${hostOf(m)}" — the dynamic import of src/ would be blocked there`);
    }
  }

  const war = (manifest.web_accessible_resources || []).flatMap((r) => r.resources || []);
  if (!war.some((r) => r === 'src/*' || r.startsWith('src/'))) {
    problems.push('MANIFEST  web_accessible_resources must expose src/* so the content loader can import the modules');
  }

  const clientId = manifest.oauth2 && manifest.oauth2.client_id;
  if (clientId && clientId.includes('PASTE_YOUR_OAUTH_CLIENT_ID_HERE')) {
    notes.push('oauth2.client_id is the documented placeholder — Sheets stays disabled until replaced (this is intentional, not a defect)');
  }
  notes.push(`manifest: ${(manifest.permissions || []).length} permission(s), ${(manifest.host_permissions || []).length} host permission(s)`);
}

/* ------------------ 4b. orphan modules (dead code) -------------- */
// Entry points are reached by the manifest or an HTML page, not by an import.
const ENTRY_POINTS = new Set([
  'src/background/service-worker.js',
  'src/collector/content-loader.js',
  'src/collector/index.js',
  'src/sidepanel/app.js',
]);

const importedPaths = new Set();
for (const file of jsFiles) {
  const src = fs.readFileSync(file, 'utf8');
  for (const re of [IMPORT_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (!m[1].startsWith('.')) continue;
      const abs = path.resolve(path.dirname(file), m[1]);
      for (const candidate of [abs, `${abs}.js`, path.join(abs, 'index.js')]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          importedPaths.add(path.relative(ROOT, candidate));
          break;
        }
      }
    }
  }
}
for (const file of jsFiles) {
  const rel = path.relative(ROOT, file);
  if (ENTRY_POINTS.has(rel) || importedPaths.has(rel)) continue;
  problems.push(`ORPHAN MODULE  ${rel} is never imported and is not an entry point — dead code, or a duplicate implementation`);
}
notes.push(`checked ${jsFiles.length} module(s) for orphans`);

/* ---------------------- 5. HTML references --------------------- */
for (const file of allFiles.filter((f) => f.endsWith('.html'))) {
  const src = fs.readFileSync(file, 'utf8');
  const refs = [...src.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (/^(https?:|data:|#|mailto:)/.test(ref)) continue;
    const target = path.resolve(path.dirname(file), ref);
    if (!fs.existsSync(target)) problems.push(`HTML  ${path.relative(ROOT, file)} references missing ${ref}`);
  }
}

/* --------------------- 6. forbidden patterns ------------------- */
for (const file of jsFiles) {
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  if (/\brequire\s*\(/.test(src)) problems.push(`CJS  ${rel} uses require() in an ES module`);
  if (/\beval\s*\(/.test(src)) problems.push(`CSP  ${rel} uses eval(), which MV3's CSP forbids`);
  if (/\bnew\s+Function\s*\(/.test(src)) problems.push(`CSP  ${rel} uses new Function(), which MV3's CSP forbids`);
  if (/\blocalStorage\b/.test(src)) problems.push(`STORAGE  ${rel} uses localStorage; use chrome.storage instead`);
}

/* ---------------------------- report --------------------------- */
console.log('\n  Build verification\n  ' + '='.repeat(52) + '\n');
for (const n of notes) console.log(`  note  ${n}`);
console.log('');

if (problems.length) {
  console.log(`  ${problems.length} problem(s):\n`);
  for (const p of problems) console.log(`  ${p}`);
  console.log('');
  process.exit(1);
}
console.log('  No problems found.\n');
