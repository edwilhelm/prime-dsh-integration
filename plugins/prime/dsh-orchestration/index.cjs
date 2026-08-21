// ============================================================================
// dsh-orchestration — spawn caps, budget inheritance, dead letters (§4.3)
// ============================================================================
// v0.1 scope at the existing subagent seam (P7): recursive delegation is
// bounded BY CONSTRUCTION, every denial is journaled (`family/dead-letter`),
// nothing vanishes silently.
//
//   Concurrency caps   a monotonic tools.guard denies `subagent` /
//                      `subagent_fork` while a parent is at its cap; caps come
//                      from ctx.policy / settings (`prime.budgets.children`).
//   Budget inheritance P12: every allowed spawn journals the explicit
//                      sub-budget derived from policy.childBudget(); the
//                      ceiling itself is enforced by dsh-autonomy's
//                      turn-stopping on child sessions.
//   Cancellation       parent disposal cancels owned live children by default
//                      (named detach exceptions are Phase-4 work).
//
// Message priorities and a dedicated family transport are out-of-tree Phase-4
// work (see README "Not yet implemented").
// ============================================================================
'use strict';

const journal = require('../lib/journal.cjs');

const name = 'dsh-orchestration';

const inject = ['tools', 'agents', 'policy', 'settings', 'systemPrompt'];

const SPAWN_TOOLS = new Set(['subagent', 'subagent_fork']);

module.exports = {
  name,
  inject,

  apply(ctx) {
    const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : require('node:path').join(require('node:os').homedir(), '.dsh');

    const log = (message) => {
      try { ctx.logger?.warn?.(message); } catch (_err) { process.stderr.write(`${message}\n`); }
    };

    function liveChildrenOf(parent) {
      const children = [];
      for (const agent of ctx.agents.list()) {
        if (ctx.agents.isOwnedBy(agent.id, parent)) children.push(agent);
      }
      return children;
    }

    // ── concurrency caps + dead-letter journal ─────────────────────────────
    ctx.tools.guard((execution) => {
      if (!SPAWN_TOOLS.has(execution.name)) return undefined;
      const parent = execution.agent;
      if (parent === undefined || parent === null) return undefined;

      const budget = ctx.policy.childBudget(Number.MAX_SAFE_INTEGER);
      const cap = Math.max(1, budget.maxConcurrency ?? 4);
      const children = liveChildrenOf(parent);
      if (children.length < cap) return undefined;

      const sessionId = String(parent.id);
      journal.append(home, sessionId, 'family', 'family/dead-letter', {
        message_id: `${sessionId}:${Date.now()}`,
        source: sessionId,
        target: '(pending-spawn)',
        reason: `concurrency-cap:${children.length}/${cap}`,
        retry_count: 0,
        tool: execution.name,
      });
      return `subagent spawn denied: parent already has ${children.length} live children (cap ${cap}); wait for one to finish or raise prime.budgets.children.maxConcurrency`;
    });

    // ── budget inheritance record on allowed spawns ────────────────────────
    ctx.on('agent/created', (payload) => {
      const child = payload?.agent;
      if (child === undefined || child === null) return;
      const header = child.session?.header ?? {};
      if (header.origin !== 'subagent' && (header.delegationDepth ?? 0) < 1) return;
      let owner = null;
      for (const candidate of ctx.agents.roots().concat(ctx.agents.list())) {
        if (ctx.agents.isOwnedBy(child.id, candidate)) { owner = candidate; break; }
      }
      const parentId = String(owner?.id ?? header.parentSession ?? 'unknown');
      const subBudget = ctx.policy.childBudget(0);
      journal.append(home, String(child.id), 'family', 'family/message', {
        source: parentId,
        target: String(child.id),
        mode: 'task',
        priority: 'task',
        payload: { note: 'spawn with inherited sub-budget' },
        sub_budget: subBudget,
      });
    });

    // ── cancellation propagation: parent gone → cancel owned children ──────
    ctx.on('agent/disposed', (payload) => {
      const parent = payload?.agent;
      if (parent === undefined || parent === null) return;
      for (const child of liveChildrenOf(parent)) {
        try {
          child.cancel({ kind: 'parent' });
          journal.append(home, String(child.id), 'family', 'family/dead-letter', {
            message_id: `${child.id}:${Date.now()}`,
            source: String(parent.id),
            target: String(child.id),
            reason: 'parent-cancelled',
            retry_count: 0,
          });
        } catch (error) {
          log(`dsh-orchestration: failed to cancel child ${child.id}: ${error?.message ?? error}`);
        }
      }
    });

    // ── operator view ───────────────────────────────────────────────────────
    ctx.systemPrompt?.section?.({
      name: 'prime:orchestration',
      order: 119,
      text: () => [
        'Delegation discipline: spawn the fewest children that cover the task, one coherent subtask each.',
        'Children inherit explicit token budgets from this session; a denied spawn means the family is at capacity — finish or stop a child before spawning again.',
      ].join(' '),
    });
  },
};
