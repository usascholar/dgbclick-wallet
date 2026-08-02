// vendor:verify — the check `vendor.lock` cannot do for itself.
//
//   npm run vendor:verify            # CI + pre-deploy
//
// vendor.lock proves DISK matches LOCK. It cannot prove LOCK matches UPSTREAM:
// the same hand that edits a vendored file can re-run `npm run vendor:lock`,
// and boot verification goes green on tampered bytes. That is the re-lock
// attack, and it is the residual risk both entropy audits landed on.
//
// Three stages, cheapest first:
//   1. disk vs lock            — same check the server does at boot
//   2. installed vs package-lock.json — versions must be exactly what the
//                                lockfile pins (deploys use `npm ci`)
//   3. lock vs PUBLISHED npm   — re-download each package's exact published
//                                tarball, hash its files, and compare. This is
//                                the stage a hand-regenerated lock cannot pass,
//                                because the tampered file's hash will not
//                                match the bytes npm actually published.
//
// Stage 3 needs the network. `--offline` runs 1+2 only and says so loudly
// rather than exiting 0 on a partial check.
import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { INTEGRITY_ROOTS } from '../server.js';
import { hashVendorTree, verifyVendorTree, describeVendorFailure } from '../vendor-integrity.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WALLET_DIR = join(HERE, '..');
const REPO_ROOT = join(WALLET_DIR, '..', '..');
// npm workspace runs swallow '--' args unreliably, so honour an env var too:
//   VENDOR_VERIFY_OFFLINE=1 npm run vendor:verify
const OFFLINE = process.argv.includes('--offline') || process.env.VENDOR_VERIFY_OFFLINE === '1';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// Windows npm is a .cmd shim: execFile cannot spawn it without a shell (EINVAL).
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32', ...opts,
  }).trim();

let failed = false;
const fail = (stage, detail) => { failed = true; console.error(`\n✗ ${stage}\n${detail}`); };
const pass = (stage, detail) => console.log(`✓ ${stage}${detail ? ` — ${detail}` : ''}`);

// ---- Stage 1: disk vs lock ----
const lock = JSON.parse(readFileSync(join(WALLET_DIR, 'vendor.lock'), 'utf8'));
const result = verifyVendorTree(INTEGRITY_ROOTS, lock);
if (result.ok) pass('disk matches vendor.lock', `${Object.keys(lock).length} files`);
else fail('disk does NOT match vendor.lock', describeVendorFailure(result));

// ---- Stage 1b: what DEPLOY will ship vs the lock ----
// The lock is generated from the WORKING COPY, but production is deployed from
// `git archive`, and on Windows those differ in line endings: a freshly written
// LF file hashes differently than the CRLF bytes git checks out and archives.
// Because boot verification is fail-CLOSED, that mismatch does not degrade —
// it takes every site down at restart. Caught exactly that way once; this stage
// is the guard. Skipped when not in a git work tree (deployed servers).
try {
  const inGit = run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: REPO_ROOT }) === 'true';
  if (inGit) {
    const tmp = mkdtempSync(join(tmpdir(), 'vendor-archive-'));
    try {
      execFileSync('git', ['archive', 'HEAD'], { cwd: REPO_ROOT, maxBuffer: 1 << 28 })
        && run('git', ['archive', 'HEAD', '--output', join(tmp, 'a.tar')], { cwd: REPO_ROOT });
      run('tar', ['-xf', 'a.tar'], { cwd: tmp });
      const drift = [];
      for (const [path, digest] of Object.entries(lock)) {
        if (!path.startsWith('digidollar-js/')) continue; // only /lib comes from git
        const f = join(tmp, 'packages', 'digidollar-js', 'src', path.slice('digidollar-js/'.length));
        if (!existsSync(f)) { drift.push(`${path} (absent from git archive)`); continue; }
        if (createHash('sha256').update(readFileSync(f)).digest('hex') !== digest) drift.push(path);
      }
      if (drift.length) {
        fail('git archive does NOT match vendor.lock (deploy would refuse to boot)',
          drift.map((p) => `    ${p}`).join('\n') +
          '\n  Line-ending drift between the working copy and git.' +
          '\n  Fix: rm the file, `git checkout --` it, then `npm run vendor:lock`.');
      } else {
        pass('git archive matches vendor.lock', 'deploy will boot');
      }
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
} catch { /* not a git tree (e.g. a deployed server): stage 1 already covered disk */ }

// ---- Stage 2: installed versions vs package-lock.json ----
// The vendored trees must be the versions the lockfile pins. A drifted install
// (npm install on a stale tree, a hand-copied package) shows up here.
const pkgLock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'));
const VENDORED = Object.keys(INTEGRITY_ROOTS).filter((p) => p !== 'digidollar-js');
const versions = {};
for (const pkg of VENDORED) {
  const installedPath = join(REPO_ROOT, 'node_modules', pkg, 'package.json');
  if (!existsSync(installedPath)) { fail(`installed version of ${pkg}`, '  package is not installed'); continue; }
  const installed = JSON.parse(readFileSync(installedPath, 'utf8')).version;
  const pinned = pkgLock.packages?.[`node_modules/${pkg}`]?.version;
  if (!pinned) fail(`${pkg} in package-lock.json`, '  not pinned in the lockfile');
  else if (pinned !== installed) fail(`${pkg} version drift`, `  installed ${installed}, lockfile pins ${pinned}`);
  else versions[pkg] = installed;
}
if (Object.keys(versions).length === VENDORED.length) {
  pass('installed versions match package-lock.json', VENDORED.map((p) => `${p}@${versions[p]}`).join(', '));
}

// digidollar-js is FIRST-PARTY: it has no npm tarball to compare against, so
// stage 3 cannot cover it. Its protection is stage 1 plus code review — say so
// rather than let a reader assume the npm cross-check spans everything.
console.log('  note: digidollar-js is first-party (no published tarball); stages 1 + review cover it');

// ---- Stage 3: lock vs the PUBLISHED npm tarball ----
if (OFFLINE) {
  console.log('\n! --offline: skipped the npm cross-check (stage 3).');
  console.log('  Stages 1+2 alone CANNOT detect a re-locked tamper. Run online before deploying.');
} else {
  const tmp = mkdtempSync(join(tmpdir(), 'vendor-verify-'));
  try {
    for (const pkg of VENDORED) {
      const version = versions[pkg];
      if (!version) continue;
      const dest = join(tmp, pkg.replace('/', '+'));
      mkdirSync(dest, { recursive: true }); // npm pack does NOT create --pack-destination
      try {
        // `npm pack` fetches the exact published tarball for that version.
        run(npm, ['pack', `${pkg}@${version}`, '--pack-destination', dest, '--silent'], { cwd: tmp });
      } catch (e) {
        fail(`fetch published ${pkg}@${version}`, `  ${String(e.message).split('\n')[0]}`);
        continue;
      }
      const tgz = readdirSync(dest).find((f) => f.endsWith('.tgz'));
      if (!tgz) { fail(`unpack ${pkg}@${version}`, '  npm pack produced no tarball'); continue; }
      const unpacked = join(dest, 'unpacked');
      mkdirSync(unpacked, { recursive: true });
      // RELATIVE paths + cwd, never absolute: a Windows absolute path contains
      // "C:", which tar parses as a remote host spec ("resolve failed").
      run('tar', ['-xzf', tgz, '-C', 'unpacked'], { cwd: dest });
      // npm tarballs unpack under package/
      const pubRoot = join(unpacked, 'package');
      const published = hashVendorTree({ [pkg]: pubRoot });
      // Compare only the paths the lock actually covers for this package: the
      // published tarball may carry extra files the seam never serves.
      const mismatched = [];
      for (const [path, digest] of Object.entries(lock)) {
        if (!path.startsWith(`${pkg}/`)) continue;
        if (!(path in published)) continue; // not shipped in the tarball; stage 1 owns it
        if (published[path] !== digest) mismatched.push(path);
      }
      if (mismatched.length) {
        fail(`${pkg}@${version} does NOT match the published tarball`,
          mismatched.slice(0, 10).map((p) => `    ${p}`).join('\n') +
          (mismatched.length > 10 ? `\n    … and ${mismatched.length - 10} more` : '') +
          '\n  A vendored file was modified AND vendor.lock regenerated to hide it.');
      } else {
        pass(`${pkg}@${version} matches the published npm tarball`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (failed) {
  console.error('\nvendor:verify FAILED — do not deploy this tree.');
  process.exit(1);
}
console.log('\nvendor:verify passed.');
