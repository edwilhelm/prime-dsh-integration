// ============================================================================
// dsh-prime-ops — in-session observability (plan §4.8)
// ============================================================================
// The operator CLI lives in tools/prime-ops.mjs (offline: verify / refine /
// kernel inspect / family tree over logs + sidecars). This plugin gives the
// MODEL the same window: prime_status reports budgets, kernel stats,
// refinement layers, and family shape for the calling session.
// ============================================================================
'use strict';

const journal = require('../lib/journal.cjs');

const name = 'dsh-prime-ops';

const inject = ['tools', 'agents', 'primeKernel', 'policy'];

module.exports = {
  name,
  inject,

  apply(ctx) {
    const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : require('node:path').join(require('node:os').homedir(), '.dsh');

    ctx.tools.register({
      name: 'prime_status',
      description: 'Read this session\'s integration status: token budget usage, kernel exec stats and effect classes, refinement layer count, live family members. Use it to self-check before long autonomous stretches.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            report: { type: 'string' },
          },
          required: ['report'],
          additionalProperties: false,
        },
        render(_args, value) { return [{ type: 'text', text: value.report }]; },
      },
      async execute(_args, exec) {
        const agent = exec.agent;
        const sessionId = String(agent?.id ?? 'unowned');
        const events = agent?.session?.events ?? [];
        let tokens = 0;
        for (const event of events) {
          if (event.type !== 'assistant/message') continue;
          const usage = event.data?.usage;
          if (usage !== undefined && usage !== null) tokens += (Number(usage.input ?? 0) || 0) + (Number(usage.output ?? 0) || 0);
        }
        const turns = new Set(events.filter((e) => e.type === 'turn/start').map((e) => e.data.turn)).size;
        const kernelStats = ctx.primeKernel.stats(sessionId);
        const digest = ctx.primeKernel.envDigest();
        const children = agent === undefined ? [] : ctx.agents.list().filter((a) => ctx.agents.isOwnedBy(a.id, agent));
        const refineCount = journal.readAll(home, sessionId, 'refine')
          .filter((r) => r.type === 'refine/applied' || r.type === 'refine/proposed').length;
        const lines = [
          `session ${sessionId}: ${turns} turns, ~${tokens} tokens billed`,
          `kernel: ${kernelStats.execs} execs (${JSON.stringify(kernelStats.byClass)}), ${kernelStats.redactions} redactions; env digest ${digest.digest} (${digest.redactedNames} secret-named vars scrubbed)`,
          `family: ${children.length} live child(ren)`,
          `refinements recorded: ${refineCount}`,
          `policy: ${JSON.stringify(ctx.policy.describe().children)}`,
        ];
        return { report: lines.join('\n') };
      },
      presentCall: () => ({ card: 'generic', title: 'prime status', kind: 'read' }),
    });
  },
};
