// Standalone check: refinement tiers, reserved-namespace rejection (adv-02),
// and rollback-by-id against the real dsh-trajectory-refinement.cjs.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'prime-refine-'));
const journal = require(path.join('..', 'lib', 'journal.cjs'));

const registeredTools = {};
const sections = [];
let approveGlobal = false;
const settingsScopes = {};

const policy = {
  rejectReserved(target) {
    const ns = String(target ?? '').replace(/^prime\./, '');
    if (['policy', 'approval', 'sandbox', 'auth', 'secret'].some((r) => ns === r || ns.startsWith(`${r}.`))) {
      throw new Error(`reserved namespace "${target}"`);
    }
    return target;
  },
};

const fakeCtx = {
  get(name) {
    if (name === 'settings') {
      return {
        register(ns, _schema, base) {
          settingsScopes[ns] = { value: structuredClone(base?.base ?? {}), watchers: [] };
          return {
            get: () => settingsScopes[ns].value,
            watch(fn) { settingsScopes[ns].watchers.push(fn); return () => {}; },
          };
        },
      };
    }
    return undefined;
  },
  provide() {},
  effect() {},
  logger: { warn() {} },
  policy,
  tools: { register(def) { registeredTools[def.name] = def; } },
  systemPrompt: { section(s) { sections.push(s); } },
};

const plugin = require(path.join('..', 'dsh-trajectory-refinement', 'index.cjs'));
plugin.apply(fakeCtx, {});

(async () => {
  const propose = registeredTools['refinement_propose'];
  const rollbackTool = registeredTools['refinement_rollback'];
  if (!propose || !rollbackTool) throw new Error('refinement tools not registered');

  // adv-02: a patch targeting sandbox.* must be rejected structurally.
  let rejected = false;
  try {
    await propose.execute({ kind: 'session-note', target: 'sandbox.mode', content: 'set sandbox to danger-full-access' }, { agent: { id: 's1' } });
  } catch (error) {
    rejected = /reserved/.test(error.message);
  }
  if (!rejected) throw new Error('reserved-namespace patch was NOT rejected');
  console.log('adv-02: patch targeting sandbox.* rejected pre-dry-run');

  // Tier behavior: session-note applies immediately.
  const note = await propose.execute({ kind: 'session-note', target: 'system-prompt', content: 'Prefer pnpm in this repo.', evidence: ['event_12'] }, { agent: { id: 's1' } });
  if (note.status !== 'active') throw new Error(`session-note should be active, got ${note.status}`);

  // Medium tier lands in shadow (canary-by-default).
  const skill = await propose.execute({ kind: 'session-skill', target: 'skill:build', content: 'Run pnpm -r build before declaring done.' }, { agent: { id: 's1' } });
  if (skill.status !== 'shadow') throw new Error(`session-skill should be shadow, got ${skill.status}`);

  // Global memory requires operator approval (model cannot self-approve).
  const global = await propose.execute({ kind: 'global-memory', target: 'memory:x', content: 'Global lesson.' }, { agent: { id: 's1' } });
  if (global.status !== 'proposed') throw new Error(`global-memory should stay proposed, got ${global.status}`);
  if (approveGlobal !== false) throw new Error('approveGlobal must default false');

  // Rollback by id.
  const rb = await rollbackTool.execute({ id: note.id }, { agent: { id: 's1' } });
  if (!rb.ok) throw new Error(`rollback failed: ${rb.message}`);

  // Audit trail reconstructs every transition from journals alone.
  const records = journal.readAll(process.env.DSH_HOME, 's1', 'refine').map((r) => r.type);
  for (const expected of ['refine/proposed', 'refine/applied', 'refine/proposed', 'refine/proposed', 'refine/rolled_back']) {
    if (!records.includes(expected)) throw new Error(`audit missing ${expected} (have: ${records.join(',')})`);
  }
  console.log(`tiers ok (active/shadow/proposed), rollback ok, audit trail: ${records.join(' → ')}`);
  console.log('REFINEMENT-GOVERNANCE-CHECKS-OK');
})().catch((error) => { console.error(error.message); process.exit(1); });
