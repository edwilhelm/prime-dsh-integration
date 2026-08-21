#!/usr/bin/env node
// ============================================================================
// scripts/drift-check.cjs — repo vs installed harness home (source of truth)
// ============================================================================
// The integration lives in two places: this repo and the installed copy under
// the dsh home. This script hashes every file on both sides and reports any
// difference, so "fixed it live, forgot the repo" (or the reverse) can never
// ship silently.
//
//   node scripts/drift-check.cjs                 # uses $DSH_HOME or ~\.dsh
//   node scripts/drift-check.cjs --home D:\my-dsh
//
// Exit codes: 0 in sync, 1 drift found, 2 usage error.
// ============================================================================
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const homeIdx = argv.indexOf('--home');
const dshHome = homeIdx >= 0 ? path.resolve(argv[homeIdx + 1] ?? '') : (process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh'));

// repo-relative tree ↔ installed tree (note the dot in the preset root)
const PAIRS = [
  ['plugins/prime', 'plugins/prime'],
  ['profiles/prime-web', 'profiles/prime-web'],
  ['profiles/prime-headless', 'profiles/prime-headless'],
  ['agent-presets/prime-rlm', '.agent-presets/prime-rlm'],
];

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

let drift = 0;

for (const [repoRel, homeRel] of PAIRS) {
  const repoDir = path.join(repoRoot, repoRel);
  const homeDir = path.join(dshHome, homeRel);

  if (!fs.existsSync(repoDir)) {
    console.error(`MISSING IN REPO: ${repoRel}`);
    drift += 1;
    continue;
  }
  if (!fs.existsSync(homeDir)) {
    console.error(`NOT INSTALLED: ${homeRel} (run install.ps1 / install.sh)`);
    drift += 1;
    continue;
  }

  const repoFiles = new Map(walk(repoDir).map((f) => [path.relative(repoDir, f), f]));
  const homeFiles = new Map(walk(homeDir).map((f) => [path.relative(homeDir, f), f]));

  for (const [rel, repoFile] of repoFiles) {
    const homeFile = homeFiles.get(rel);
    if (homeFile === undefined) {
      console.log(`ONLY IN REPO   ${repoRel}/${rel}`);
      drift += 1;
    } else if (hash(repoFile) !== hash(homeFile)) {
      console.log(`DIFFERS        ${repoRel}/${rel}`);
      drift += 1;
    }
  }
  for (const [rel] of homeFiles) {
    if (!repoFiles.has(rel)) {
      console.log(`ONLY INSTALLED ${homeRel}/${rel}  (delete from home or commit to repo)`);
      drift += 1;
    }
  }
}

if (drift === 0) {
  console.log(`in sync: repo <-> ${dshHome}`);
  process.exit(0);
}
console.error(`\n${drift} drift item(s) between repo and ${dshHome}`);
console.error('re-run install.ps1 / install.sh to push repo -> home, or commit home-side fixes into the repo first.');
process.exit(1);
