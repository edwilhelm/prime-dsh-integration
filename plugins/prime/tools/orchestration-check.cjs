// Standalone check: dsh-orchestration spawn caps, dead-letter journaling, and
// cancellation propagation against the real plugin code with a stubbed context.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'prime-orch-'));
const journal = require(path.join('..', 'lib', 'journal.cjs'));

const listeners = {};
const guards = [];
const registeredTools = [];

const parent = { id: 'parent-1' };
const childrenOfParent = [];

const fakeCtx = {
  get() { return undefined; },
  provide() {},
  effect() {},
  on(name, fn) { listeners[name] = fn; },
  logger: { warn() {} },
  systemPrompt: { section() {} },
  policy: {
    childBudget() {
      return { maxTokens: 250000, maxTotalTokens: 1000000, maxConcurrency: 2 };
    },
    describe() { return {}; },
  },
  tools: {
    register(def) { registeredTools.push(def.name); },
    guard(fn) { guards.push(fn); },
  },
  agents: {
    list: () => [...childrenOfParent],
    roots: () => [parent],
    isOwnedBy: (childId, owner) => owner === parent && childrenOfParent.some((c) => c.id === childId),
  },
};

const plugin = require(path.join('..', 'dsh-orchestration', 'index.cjs'));
plugin.apply(fakeCtx, {});

(async () => {
  if (guards.length !== 1) throw new Error('expected exactly one tools.guard registration');
  const guard = guards[0];

  // Under the cap (0/2 live children) → allowed.
  let denial = guard({ name: 'subagent', agent: parent });
  if (denial !== undefined) throw new Error(`spawn denied under cap: ${denial}`);

  // At the cap (2/2) → denied + dead-letter journaled.
  childrenOfParent.push({ id: 'c1' }, { id: 'c2' });
  denial = guard({ name: 'subagent', agent: parent });
  if (typeof denial !== 'string' || !denial.includes('cap')) throw new Error(`expected cap denial, got: ${denial}`);
  const dead = journal.readAll(process.env.DSH_HOME, 'parent-1', 'family').filter((r) => r.type === 'family/dead-letter');
  if (dead.length !== 1 || !dead[0].data.reason.startsWith('concurrency-cap')) throw new Error('dead letter not journaled for denied spawn');

  // Budget inheritance record on child creation.
  listeners['agent/created']({ agent: { id: 'c3', session: { header: { origin: 'subagent', delegationDepth: 1 } } } });
  const messages = journal.readAll(process.env.DSH_HOME, 'c3', 'family').filter((r) => r.type === 'family/message');
  if (messages.length !== 1 || messages[0].data.sub_budget.maxTokens !== 250000) {
    throw new Error('spawn did not record an inherited sub-budget');
  }

  // Parent disposal cancels owned children; unowned agents are untouched.
  const owned = { id: 'c3', cancels: [], cancel(cause) { this.cancels.push(cause); } };
  const stranger = { id: 'zz', cancels: [], cancel() { throw new Error('stranger cancelled'); } };
  childrenOfParent.push(owned, stranger);
  fakeCtx.agents.isOwnedBy = (childId, owner) => owner === parent && childId === 'c3';
  listeners['agent/disposed']({ agent: parent });
  if (owned.cancels.length !== 1 || owned.cancels[0].kind !== 'parent') throw new Error('owned child not cancelled on parent disposal');
  const orphanLetters = journal.readAll(process.env.DSH_HOME, 'c3', 'family').filter((r) => r.data?.reason === 'parent-cancelled');
  if (orphanLetters.length !== 1) throw new Error('parent-cancelled dead letter missing');

  console.log('caps enforced at 2/2, dead letters recorded, sub-budgets inherited, cancellation propagates to owned children only');
  console.log('ORCHESTRATION-CHECKS-OK');
})().catch((error) => { console.error(error.message); process.exit(1); });
