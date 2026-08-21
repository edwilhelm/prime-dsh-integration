#!/usr/bin/env node
// ============================================================================
// prime-bench — three-arm benchmark rig skeleton (plan §3, §7)
// ============================================================================
// Runs one task against one arm using the dsh headless profile (one-shot task
// mode), pins provider/model via env, and records token/cost rows under
// storages/prime/bench/. Arms:
//
//   control   --profile headless                                (Minimal)
//   default   --profile headless                                (stock loop)
//   rlm       --profile prime-headless + DSH_TOOLS_MODE=both
//
// Preset note: the headless driver creates agents WITHOUT joining an agent
// preset (verified in dsh-headless/lib/index.js run()), so `prime-rlm` cannot
// be selected here. The rlm arm instead exercises the prime profile's
// host-plane rows (kernel, envelope QC, budgets, caps) plus dsh's own
// deployment-level presentation switch DSH_TOOLS_MODE. Code-Mode-per-preset
// benchmarking runs on the web profile where sessions name presets.
//
// The runner is honest about what it cannot do yet: cost-after-cache-discount
// needs the Phase-0 cache baseline; success detection is gate-exit-code based.
// Adversarial tasks come from benchmarks/tasks.md and are judged by their
// detection criteria, not exit codes.
// ============================================================================
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME
  : path.join(os.homedir(), '.dsh');

const ARMS = {
  control: { profile: 'headless', toolsMode: null },
  default: { profile: 'headless', toolsMode: null },
  rlm: { profile: 'prime-headless', toolsMode: 'both' },
};

function usage() {
  process.stderr.write([
    'usage: prime-bench.cjs --arm <control|default|rlm> --task "<prompt>" [--gate <command>]',
    '                       [--model-provider <p>] [--model <m>] [--max-turns <n>]',
    '',
    'Rows append to ~/.dsh/storages/prime/bench/results.jsonl',
  ].join('\n'));
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  const get = (flag) => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const armName = get('--arm');
  const task = get('--task');
  const gate = get('--gate');
  if (armName === undefined || task === undefined || ARMS[armName] === undefined) usage();

  const arm = ARMS[armName];
  const startedAt = Date.now();
  const bin = path.join(HOME, 'profiles', 'node_modules', '.bin', 'dsh.cmd');
  if (!fs.existsSync(bin)) {
    process.stderr.write(`prime-bench: dsh launcher not found at ${bin}; adjust the path for your installation\n`);
    process.exit(1);
  }

  const args = ['--profile', arm.profile, task];

  const env = { ...process.env };
  if (arm.toolsMode !== null) env.DSH_TOOLS_MODE = arm.toolsMode; else delete env.DSH_TOOLS_MODE;
  if (get('--model-provider') !== undefined) env.DSH_BENCH_PROVIDER = get('--model-provider');
  if (get('--model') !== undefined) env.DSH_BENCH_MODEL = get('--model');

  process.stdout.write(`[bench] arm=${armName} profile=${arm.profile} starting...\n`);
  const result = spawnSync(bin, args, { env, stdio: 'inherit', shell: false, timeout: 4 * 3600_000 });
  const wallMs = Date.now() - startedAt;

  let gateOk = null;
  if (gate !== undefined) {
    const gateRun = spawnSync(gate, { env, stdio: 'ignore', shell: true, timeout: 600_000 });
    gateOk = gateRun.status === 0;
  }

  const row = {
    time: new Date().toISOString(),
    arm: armName,
    profile: arm.profile,
    tools_mode: arm.toolsMode,
    provider: env.DSH_BENCH_PROVIDER ?? null,
    model: env.DSH_BENCH_MODEL ?? null,
    task_chars: task.length,
    exit_code: result.status,
    signal: result.signal ?? null,
    timed_out: result.error?.code === 'ETIMEDOUT',
    wall_ms: wallMs,
    gate_command: gate ?? null,
    gate_ok: gateOk,
    // Token accounting is filled from session stats by the analysis pass;
    // the row keeps a placeholder so schema stays stable across phases.
    tokens_in: null,
    tokens_out: null,
    cost_after_cache: null,
  };

  const benchDir = path.join(HOME, 'storages', 'prime', 'bench');
  fs.mkdirSync(benchDir, { recursive: true });
  fs.appendFileSync(path.join(benchDir, 'results.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
  process.stdout.write(`[bench] recorded row (${armName}, exit=${result.status}, ${wallMs}ms)\n`);
}

main();
