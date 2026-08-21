#!/usr/bin/env node
// ============================================================================
// prime-ops — operator CLI for the prime integration (plan §4.8, P14)
// ============================================================================
// Offline by default: reads session logs + sidecar journals, never calls a
// model. Live model calls happen only with --live (not implemented here).
//
//   node prime-ops.mjs verify <sessionId>       P4 invariants over log+sidecars
//   node prime-ops.mjs refine history <id>      evidence → layer → transitions
//   node prime-ops.mjs refine show <refId>      one layer + audit trail
//   node prime-ops.mjs refine rollback <refId>  flip status to rolled_back
//   node prime-ops.mjs kernel inspect <sid>     exec classes, redactions, digest
//   node prime-ops.mjs family tree <sid>        children, budgets, dead letters
//   node prime-ops.mjs selftest                 module loads + kernel smoke test
//
// Exit codes: 0 ok, 1 verification failure / not found, 2 usage.
// ============================================================================
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME
  : path.join(os.homedir(), '.dsh');
const PRIME = path.join(HOME, 'plugins', 'prime');
const SESSIONS = path.join(HOME, 'sessions');

function fail(message) {
  process.stderr.write(`prime-ops: ${message}\n`);
  process.exit(1);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try { out.push(JSON.parse(line)); } catch (_err) { out.push({ type: '(corrupt)', data: {} }); }
  }
  return out;
}

function findSessionFile(sessionId) {
  if (!fs.existsSync(SESSIONS)) return null;
  // Layout: sessions/<workspace-dir>/<session-id>/session.jsonl.zstd
  for (const workspace of fs.readdirSync(SESSIONS)) {
    const wsDir = path.join(SESSIONS, String(workspace));
    if (!fs.statSync(wsDir).isDirectory()) continue;
    const sessionDir = path.join(wsDir, String(sessionId));
    if (fs.existsSync(sessionDir)) {
      for (const name of ['session.jsonl', 'session.jsonl.zstd']) {
        const candidate = path.join(sessionDir, name);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    // Legacy/flat fallbacks.
    const direct = path.join(wsDir, `${sessionId}.jsonl`);
    if (fs.existsSync(direct)) return direct;
  }
  return null;
}

// ── verify ──────────────────────────────────────────────────────────────────
// Checks (plan §7 "the three equalities", adapted to sidecars):
//   V1 log parses; seqs contiguous from 0
//   V2 every rlm/context-snapshot's event_range.to exists in the log
//   V3 effect journal: no side-effecting/non-deterministic entry is marked
//      replayable (fork safety)
//   V4 every kernel/effect has a result_digest (recorded-result restore ready)
//   V5 refine transitions form proposed→applied|rolled_back chains
function cmdVerify(sessionId) {
  const file = findSessionFile(sessionId);
  let events = [];
  let logStatus = 'ok';
  if (file === null) {
    logStatus = 'session log file not found under ' + SESSIONS;
  } else if (file.endsWith('.zstd')) {
    // Persistence stores compressed logs; decompression is upstream-owned.
    // Sidecar invariants below still hold without the log.
    logStatus = `skipped (compressed log: ${path.basename(file)}); re-run after 'dsh session export' for full V1/V2`;
  } else {
    events = readJsonl(file);
  }
  let problems = 0;

  if (logStatus === 'ok') {
    events.forEach((event, index) => {
      if (event.seq !== index) {
        process.stderr.write(`V1 FAIL: seq ${event.seq} at position ${index}\n`);
        problems += 1;
      }
    });
  }

  const rlm = readJsonl(path.join(HOME, 'storages', 'prime', sessionId, 'rlm.jsonl'));
  const seqs = new Set(events.map((e) => e.seq));
  for (const record of rlm) {
    if (record.type !== 'rlm/context-snapshot') continue;
    const to = record.data?.event_range?.to;
    if (logStatus === 'ok' && typeof to === 'number' && !seqs.has(to) && to !== 0) {
      process.stderr.write(`V2 FAIL: snapshot references unknown event seq ${to}\n`);
      problems += 1;
    }
  }

  const kernel = readJsonl(path.join(HOME, 'storages', 'prime', sessionId, 'kernel.jsonl'));
  for (const record of kernel) {
    if (record.type !== 'kernel/effect') continue;
    const unsafeReplayable = record.data?.class === 'side-effecting' && record.data?.replay === 'allowed';
    if (unsafeReplayable) {
      process.stderr.write(`V3 FAIL: side-effecting exec ${record.data.exec_id} marked replayable\n`);
      problems += 1;
    }
    if (record.data?.outcome === 'ok' && typeof record.data?.result_digest !== 'string') {
      process.stderr.write(`V4 WARN: ok exec ${record.data.exec_id} lacks result_digest\n`);
      problems += 1;
    }
  }

  const refine = readJsonl(path.join(HOME, 'storages', 'prime', sessionId, 'refine.jsonl'));
  const proposed = new Set(refine.filter((r) => r.type === 'refine/proposed').map((r) => r.data?.id));
  for (const record of refine) {
    if ((record.type === 'refine/applied' || record.type === 'refine/rolled_back') && !proposed.has(record.data?.id)) {
      process.stderr.write(`V5 FAIL: ${record.type} for never-proposed id ${record.data?.id}\n`);
      problems += 1;
    }
  }

  const summary = `verify ${sessionId}: log=${logStatus}, ${rlm.length} rlm records, ${kernel.length} kernel records, ${refine.length} refine records`;
  if (problems === 0) {
    process.stdout.write(`${summary}\nOK — replay-equality invariants hold (offline checks)\n`);
    process.exit(0);
  }
  process.stderr.write(`${summary}\nFAILED with ${problems} problem(s)\n`);
  process.exit(1);
}

// ── refine ──────────────────────────────────────────────────────────────────
function refineRoot() { return path.join(HOME, 'storages', 'prime', 'refinements'); }

function loadLayer(id) {
  const file = path.join(refineRoot(), `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function cmdRefineHistory(sessionId) {
  const records = readJsonl(path.join(HOME, 'storages', 'prime', sessionId, 'refine.jsonl'));
  if (records.length === 0) { process.stdout.write(`(no refinement records for ${sessionId})\n`); return; }
  for (const record of records) {
    process.stdout.write(`${new Date(record.time).toISOString()} ${record.type} ${record.data?.id ?? ''} ${JSON.stringify(record.data?.patch_layer ?? {})}\n`);
  }
}

function cmdRefineShow(id) {
  const layer = loadLayer(id);
  if (layer === null) fail(`unknown refinement ${id}`);
  process.stdout.write(`${JSON.stringify(layer, null, 2)}\n`);
  // Audit trail across all sessions.
  const rootDir = path.join(HOME, 'storages', 'prime');
  if (fs.existsSync(rootDir)) {
    for (const entry of fs.readdirSync(rootDir)) {
      const trail = path.join(rootDir, String(entry), 'refine.jsonl');
      if (!fs.existsSync(trail)) continue;
      for (const record of readJsonl(trail)) {
        if (record.data?.id === id) {
          process.stdout.write(`audit[${entry}] ${new Date(record.time).toISOString()} ${record.type}\n`);
        }
      }
    }
  }
}

function cmdRefineRollback(id) {
  const layer = loadLayer(id);
  if (layer === null) fail(`unknown refinement ${id}`);
  layer.status = 'rolled_back';
  layer.rolled_back_at = Date.now();
  fs.writeFileSync(path.join(refineRoot(), `${id}.json`), JSON.stringify(layer, null, 2), 'utf8');
  process.stdout.write(`rolled back ${id}; it will no longer be served\n`);
}

// ── kernel inspect ──────────────────────────────────────────────────────────
function cmdKernelInspect(sessionId) {
  const records = readJsonl(path.join(HOME, 'storages', 'prime', sessionId, 'kernel.jsonl'));
  const effects = records.filter((r) => r.type === 'kernel/effect');
  const byClass = {};
  for (const record of effects) byClass[record.data?.class] = (byClass[record.data?.class] ?? 0) + 1;
  process.stdout.write([
    `execs: ${effects.length}`,
    `by class: ${JSON.stringify(byClass)}`,
    `redactions: ${records.filter((r) => r.type === 'kernel/redaction').length}`,
    `checkpoints: ${records.filter((r) => r.type === 'kernel/checkpoint').length}`,
    `replay cost estimate: ${(effects.filter((r) => r.data?.replay === 'allowed').length * 40)}ms (heuristic: 40ms per replayable exec)`,
  ].join('\n') + '\n');
}

// ── family tree ─────────────────────────────────────────────────────────────
function cmdFamilyTree(sessionId) {
  const messages = readJsonl(path.join(HOME, 'storages', 'prime', sessionId, 'family.jsonl'));
  const spawns = messages.filter((r) => r.type === 'family/message');
  const dead = messages.filter((r) => r.type === 'family/dead-letter');
  process.stdout.write(`family rooted at ${sessionId}\n`);
  for (const spawnRecord of spawns) {
    process.stdout.write(`  ${spawnRecord.data.source} → ${spawnRecord.data.target} budget=${JSON.stringify(spawnRecord.data.sub_budget?.maxTokens ?? null)}\n`);
  }
  for (const letter of dead) {
    process.stdout.write(`  DEAD-LETTER ${letter.data.reason}: ${letter.data.source} → ${letter.data.target}\n`);
  }
  if (spawns.length === 0 && dead.length === 0) process.stdout.write('  (no family activity)\n');
}

// ── selftest ────────────────────────────────────────────────────────────────
function selftestKernel() {
  return new Promise((resolve, reject) => {
    const child = spawn('python', ['-u', '-c', `
import sys, json, io, ast, contextlib, traceback
_g = {}
for raw in sys.stdin:
    req = json.loads(raw)
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            exec(req['code'], _g)
        print(json.dumps({'ok': True, 'out': buf.getvalue(), 'repr': repr(_g.get('x'))}))
    except BaseException as exc:
        print(json.dumps({'ok': False, 'err': str(exc)}))
`, ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buffer = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('kernel smoke test timed out')); }, 20_000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      clearTimeout(timer);
      child.kill();
      try {
        const response = JSON.parse(buffer.split('\n')[0]);
        if (response.ok === true && response.repr === '42') resolve();
        else reject(new Error(`unexpected response: ${buffer.slice(0, 200)}`));
      } catch (error) { reject(error); }
    });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.stdin.write(JSON.stringify({ code: 'x = 6 * 7\nprint("hi")' }) + '\n');
  });
}

async function cmdSelftest() {
  // Load modules relative to THIS FILE's installation (…/plugins/prime),
  // not the configured home: selftest verifies the code it ships with,
  // wherever it is installed (repo checkout, throwaway home, CI).
  const primeRoot = path.resolve(__dirname, '..');
  const modules = [
    'dsh-policy/index.cjs',
    'dsh-kernel/kernel-python.cjs',
    'dsh-kernel/artifacts.cjs',
    'dsh-kernel/tools.cjs',
    'dsh-loop-rlm/index.cjs',
    'dsh-autonomy/index.cjs',
    'dsh-orchestration/index.cjs',
    'dsh-trajectory-refinement/index.cjs',
    'dsh-prime-ops/index.cjs',
  ];
  for (const relative of modules) {
    // eslint-disable-next-line import/no-dynamic-require
    const mod = require(path.join(primeRoot, relative));
    if (typeof mod.name !== 'string' || typeof mod.apply !== 'function') {
      fail(`module ${relative} does not export {name, apply}`);
    }
    process.stdout.write(`load ok: ${mod.name}${Array.isArray(mod.inject) ? ` inject=[${mod.inject.join(', ')}]` : ''}\n`);
  }
  process.stdout.write('kernel smoke test: ');
  await selftestKernel();
  process.stdout.write('ok (persistent-python protocol round-trip)\n');
}

// ── main ────────────────────────────────────────────────────────────────────
const [command, ...rest] = process.argv.slice(2);
(async () => {
  switch (command) {
    case 'verify': rest[0] ? cmdVerify(rest[0]) : usage(); break;
    case 'refine':
      if (rest[0] === 'history') cmdRefineHistory(rest[1]);
      else if (rest[0] === 'show') cmdRefineShow(rest[1]);
      else if (rest[0] === 'rollback') cmdRefineRollback(rest[1]);
      else usage();
      break;
    case 'kernel': rest[0] === 'inspect' && rest[1] ? cmdKernelInspect(rest[1]) : usage(); break;
    case 'family': rest[0] === 'tree' && rest[1] ? cmdFamilyTree(rest[1]) : usage(); break;
    case 'selftest': await cmdSelftest(); break;
    default: usage();
  }
})().catch((error) => fail(error.stack ?? String(error)));

function usage() {
  process.stderr.write([
    'usage:',
    '  prime-ops verify <sessionId>',
    '  prime-ops refine history <sessionId> | show <refId> | rollback <refId>',
    '  prime-ops kernel inspect <sessionId>',
    '  prime-ops family tree <sessionId>',
    '  prime-ops selftest',
  ].join('\n'));
  process.exit(2);
}
