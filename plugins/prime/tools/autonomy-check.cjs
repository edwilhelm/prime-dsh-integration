// Standalone check: dsh-autonomy kill switch + hierarchical budget enforcement
// against the real plugin code with a stubbed Cordis context.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'prime-autonomy-'));
const journal = require(path.join('..', 'lib', 'journal.cjs'));

const listeners = {};
const provided = {};
let settingsDoc = {
  session: { maxTokens: 1000, maxTurns: 10, maxWallClockMs: 3600000 },
  children: { maxTotalTokens: 500, maxPerChildTokens: 200 },
  kill: null,
};

// Real Cordis calls the effect body immediately and keeps its disposer.
const disposers = [];
function fakeEffect(fn) {
  const disposer = fn();
  if (typeof disposer === 'function') disposers.push(disposer);
}

const fakeCtx = {
  get(name) {
    if (name === 'settings') {
      return {
        register(_ns, _schema, _base) {
          return {
            get: () => settingsDoc,
            watch(fn) { listeners.__settingsWatch = fn; return () => {}; },
          };
        },
      };
    }
    return undefined;
  },
  provide(name, value) { provided[name] = value; },
  effect: fakeEffect,
  fiber: { effect: fakeEffect },
  on(name, fn) { listeners[name] = fn; },
  logger: { warn() {} },
  systemPrompt: { section() {} },
};

const plugin = require(path.join('..', 'dsh-autonomy', 'index.cjs'));
plugin.apply(fakeCtx, {});

function makeAgent(id, opts = {}) {
  const cancels = [];
  const usage = opts.usage ?? 0;
  const turns = opts.turns ?? 1;
  const events = [];
  for (let i = 0; i < turns; i += 1) events.push({ type: 'turn/start', data: { turn: i } });
  events.push({ type: 'assistant/message', data: { usage: { input: Math.floor(usage / 2), output: usage - Math.floor(usage / 2) } } });
  return {
    id,
    cancels,
    cancel(cause) { cancels.push(cause); },
    session: {
      header: { createdAt: Date.now() - (opts.ageMs ?? 0), origin: opts.origin, delegationDepth: opts.depth },
      events,
    },
  };
}

(async () => {
  const turnStopping = listeners['agent/turn-stopping'];
  if (typeof turnStopping !== 'function') throw new Error('agent/turn-stopping listener not registered');

  // 1. Under budget, no kill → no cancellation.
  const healthy = makeAgent('a1', { usage: 100 });
  await turnStopping({ turn: 1, signal: undefined, agent: healthy });
  if (healthy.cancels.length !== 0) throw new Error('healthy agent was cancelled');

  // 2. Session token budget exceeded → cancelled with budget_exceeded audit.
  const overTokens = makeAgent('a2', { usage: 1500 });
  await turnStopping({ turn: 2, signal: undefined, agent: overTokens });
  if (overTokens.cancels.length !== 1 || overTokens.cancels[0].kind !== 'hook') throw new Error('over-budget root not cancelled');
  const kills = journal.readAll(process.env.DSH_HOME, 'a2', 'autonomy').map((r) => `${r.type}:${r.data.reason}`);
  if (!kills.includes('autonomy/kill:budget_exceeded')) throw new Error(`missing budget_exceeded audit: ${kills.join(',')}`);

  // 3. Child budgets use the tighter child ceiling (P12).
  const child = makeAgent('c1', { usage: 300, origin: 'subagent', depth: 1 });
  await turnStopping({ turn: 1, signal: undefined, agent: child });
  if (child.cancels.length !== 1) throw new Error('child over its sub-budget was not cancelled');

  // 4. Kill switch via hot-reloaded settings: family scope halts everyone.
  settingsDoc.kill = { scope: 'family', reason: 'user_request' };
  listeners.__settingsWatch();
  const anyAgent = makeAgent('a3', { usage: 10 });
  await turnStopping({ turn: 1, signal: undefined, agent: anyAgent });
  if (anyAgent.cancels.length !== 1) throw new Error('family kill switch did not halt agent');
  const killReasons = journal.readAll(process.env.DSH_HOME, 'a3', 'autonomy').map((r) => r.data.reason);
  if (!killReasons.includes('user_request')) throw new Error('kill switch audit missing user_request');

  // 5. Clearing the flag releases agents again.
  settingsDoc.kill = null;
  listeners.__settingsWatch();
  const released = makeAgent('a4', { usage: 10 });
  await turnStopping({ turn: 1, signal: undefined, agent: released });
  if (released.cancels.length !== 0) throw new Error('agent cancelled after kill flag cleared');

  console.log('kill switch (<2s path = settings watch), token budgets, child sub-budgets, audit trail: all verified');
  console.log('AUTONOMY-CHECKS-OK');
})().catch((error) => { console.error(error.message); process.exit(1); });
