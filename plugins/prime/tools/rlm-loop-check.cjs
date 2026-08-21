// Standalone check: dsh-loop-rlm context snapshots, fallback router
// degradation on repeated tool failures, and the raw-user-verbatim invariant.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'prime-rlm-'));
const journal = require(path.join('..', 'lib', 'journal.cjs'));

// Minimal capability matrix so the router resolves a real route entry.
fs.mkdirSync(path.join(process.env.DSH_HOME, 'plugins', 'prime'), { recursive: true });
fs.writeFileSync(path.join(process.env.DSH_HOME, 'plugins', 'prime', 'model-capability.yml'), [
  'defaults: { rlm_ready: false, fallback_mode: standard }',
  'models:',
  '  testprov/testmodel:',
  '    rlm_ready: true',
  '    fallback_mode: code',
  '    measured: true',
].join('\n'));

const listeners = {};
let settingsDoc = { enabled: true, pinnedFacts: ['always cite sources'] };

const fakeCtx = {
  get(name) {
    if (name === 'settings') {
      return {
        register(_ns, _schema, _base) {
          return { get: () => settingsDoc, watch() { return () => {}; } };
        },
      };
    }
    return undefined;
  },
  provide() {},
  effect(fn) { fn(); },
  fiber: { effect(fn) { fn(); } },
  on(name, fn) { listeners[name] = fn; },
  logger: { warn() {} },
  systemPrompt: { section() {} },
};

const plugin = require(path.join('..', 'dsh-loop-rlm', 'index.cjs'));
plugin.apply(fakeCtx, {});

function makeAgent(id, events) {
  return {
    id,
    options: { provider: 'testprov', model: 'testmodel' },
    session: {
      header: {},
      events,
      requestContext: () => ({ provider: 'testprov', model: 'testmodel' }),
    },
  };
}

(async () => {
  const preStep = listeners['agent/pre-step'];
  const sessionEvent = listeners['session/event'];
  if (typeof preStep !== 'function' || typeof sessionEvent !== 'function') throw new Error('listeners not registered');

  const agent = makeAgent('s1', []);
  const decision = {
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'USER INSTRUCTION VERBATIM' }], source: { kind: 'user' } }],
  };

  // 1. Snapshot journaled; route resolved from agent options; raw message untouched.
  const out = await preStep({ agent, turn: 1, step: 1, signal: undefined }, () => Promise.resolve(decision));
  if (out.messages[0].content[0].text !== 'USER INSTRUCTION VERBATIM') throw new Error('user message was rewritten');
  let snaps = journal.readAll(process.env.DSH_HOME, 's1', 'rlm').filter((r) => r.type === 'rlm/context-snapshot');
  if (snaps.length !== 1 || snaps[0].data.rlm_ready !== true) throw new Error(`snapshot wrong: ${JSON.stringify(snaps)}`);

  // 2. Steering proxy: user message at step > 1 journals an interrupt record.
  await preStep({ agent, turn: 2, step: 2, signal: undefined }, () => Promise.resolve(decision));
  const interrupts = journal.readAll(process.env.DSH_HOME, 's1', 'rlm').filter((r) => r.type === 'rlm/user-interrupt');
  if (interrupts.length !== 1 || interrupts[0].data.steering !== true) throw new Error('user-interrupt not journaled');

  // 3. Router: 8 consecutive failed tool results trip degradation exactly once.
  // First arg is the live Session (carries id), matching the real dispatch.
  for (let i = 0; i < 8; i += 1) {
    sessionEvent({ id: 's1' }, { type: 'tool/result', data: { message: { isError: true }, error: { name: 'X', code: 'Y' } } });
  }
  const fallbacks = journal.readAll(process.env.DSH_HOME, 's1', 'rlm').filter((r) => r.type === 'rlm/fallback');
  if (fallbacks.length !== 1 || fallbacks[0].data.reason !== 'repeated-tool-failures') throw new Error(`fallback wrong: ${JSON.stringify(fallbacks)}`);
  for (let i = 0; i < 4; i += 1) {
    sessionEvent({ id: 's1' }, { type: 'tool/result', data: { message: { isError: true } } });
  }
  const after = journal.readAll(process.env.DSH_HOME, 's1', 'rlm').filter((r) => r.type === 'rlm/fallback');
  if (after.length !== 1) throw new Error('fallback re-fired while degraded');

  // 4. Degraded state passes decisions through untouched and stops snapshotting.
  const before = journal.readAll(process.env.DSH_HOME, 's1', 'rlm').length;
  await preStep({ agent, turn: 3, step: 1, signal: undefined }, () => Promise.resolve(decision));
  const afterSnap = journal.readAll(process.env.DSH_HOME, 's1', 'rlm').length;
  if (afterSnap !== before) throw new Error('degraded state still snapshots');

  console.log('snapshots journaled with real route identity, user text verbatim, steering recorded, router degraded once and stayed quiet');
  console.log('RLM-LOOP-CHECKS-OK');
})().catch((error) => { console.error(error.message); process.exit(1); });
