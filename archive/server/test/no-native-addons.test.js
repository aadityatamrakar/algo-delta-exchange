/**
 * Guards the invariant that unblocked the Node 16 -> 24 upgrade.
 *
 * `tulind` is a native addon (nan + node-pre-gyp) whose per-ABI prebuilds do not
 * exist for modern Node, so ANY executable require of it breaks the whole app on
 * upgrade — it loads via common/models/strategy-pnl.js, which LoopBack boots in
 * every process.
 *
 * Comments are stripped before matching: server/lib/indicators/atr.js documents
 * that it USED to require tulind, and a naive regex matches that prose.
 *
 * This walks the FILESYSTEM, not `git ls-files` — an untracked file with an
 * executable `require('tulind')` breaks the upgrade exactly as badly as a
 * committed one, and only binds this invariant in CI (where everything is
 * staged) rather than for a developer working tree pre-commit.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'legacy', '.git']);
const LIVE_EXT = /\.(js|cjs|mjs|ts)$/;

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && LIVE_EXT.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function liveJsFiles() {
  return walk(ROOT, [])
    .map(f => path.relative(ROOT, f))
    // Belt-and-braces: SKIP_DIRS already prunes legacy/ during the walk, but
    // keep this so the invariant doesn't silently depend on directory-name
    // matching alone (e.g. a symlink or nested "legacy" elsewhere).
    .filter(f => !f.startsWith('legacy' + path.sep));
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('no live file has an executable tulind require', () => {
  const offenders = [];
  for (const rel of liveJsFiles()) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (/require\(\s*['"]tulind['"]\s*\)/.test(stripComments(src))) offenders.push(rel);
  }
  assert.deepStrictEqual(
    offenders, [],
    `these files still require the tulind native addon and will break the Node upgrade:\n  ${offenders.join('\n  ')}`
  );
});

test('tulind is not a declared dependency', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.strictEqual(
    pkg.dependencies.tulind, undefined,
    'tulind must not be in dependencies — packages/indicators replaces it'
  );
});
