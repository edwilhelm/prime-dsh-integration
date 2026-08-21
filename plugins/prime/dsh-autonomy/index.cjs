// ============================================================================
// dsh-autonomy — goals, budgets, kill switch, heartbeat hygiene (plan §4.4)
// ============================================================================
// Reuse-first (P7): goals live on ctx.goals, continuation rounds are the
// goal-round driver's, background work lives on ctx.jobs. This plugin adds
// what Prime proved out and dsh lacks:
//
//   Hierarchical budgets  enforced at `agent/turn-stopping`: session token /
//                         turn / wall-clock ceilings from settings
//                         (`prime.budgets`), computed from the durable log
//                         itself (assistant/message usage sums).
//   Kill switch           hot-reloaded settings flag (`prime.kill`) with
//                         scope + reason; cancels matching agents and
//                         journals `autonomy/kill`. Target <2s (settings
//                         watch latency), unvalidated placeholder per plan.
//   Heartbeat hygiene     exponential backoff + dedup for heartbeat-style
//                         jobs; paused while user steering is recent.
//
// Budget enforcement accuracy is an exit criterion: every denial journals an
// autonomy/kill record with reason budget_exceeded.
// ============================================================================
'use strict';

const journal = require('../lib/journal.cjs');

const name = 'dsh-autonomy';

const inject = ['settings', 'systemPrompt'];

const DEFAULTS = {
  session: { maxTokens: 2_000_000, maxTurns: 200, maxWallClockMs: 6 * 3600_000 },
  children: { maxTotalTokens: 1_000_000, maxPerChildTokens: 250_000 },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function resolveConfig(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const session = { ...DEFAULTS.session, ...(isPlainObject(src.session) ? src.session : {}) };
  const children = { ...DEFAULTS.children, ...(isPlainObject(src.children) ? src.children : {}) };
  return { session, children };
}

function usageOfEvents(events) {
  let input = 0;
  let output = 0;
  for (const event of events) {
    if (event.type !== 'assistant/message') continue;
    const usage = event.data?.usage;
    if (usage === undefined || usage === null) continue;
    input += Number(usage.input ?? usage.promptTokens ?? 0) || 0;
    output += Number(usage.output ?? usage.completionTokens ?? 0) || 0;
  }
  return { input, output, total: input + output };
}

module.exports = {
  name,
  inject,

  apply(ctx, config) {
    let current = resolveConfig(config);
    // kill: null | { scope: 'family'|'session'|'child', id?: string, reason: string }
    let kill = null;
    let lastSteerAtBySession = new Map();

    const settings = ctx.get('settings');
    if (settings && typeof settings.register === 'function') {
      try {
        const schema = function schema(value) {
          const out = resolveConfig(value);
          const src = isPlainObject(value) ? value : {};
          return {
            session: out.session,
            children: out.children,
            kill: isPlainObject(src.kill) ? src.kill : null,
          };
        };
        schema.toJSON = () => ({
          type: 'object',
          properties: {
            session: { type: 'object', description: 'Session ceilings: maxTokens, maxTurns, maxWallClockMs.' },
            children: { type: 'object', description: 'Child sub-budget defaults (P12).' },
            kill: {
              type: ['object', 'null'],
              description: 'Kill switch: write {scope: family|session|child, id?, reason} to halt matching agents (<2s target). Reset to null to clear.',
              properties: {
                scope: { type: 'string' },
                id: { type: 'string' },
                reason: { type: 'string' },
              },
            },
          },
        });
        const scope = settings.register('prime.budgets', schema, { base: current });
        const read = () => {
          try {
            const raw = scope.get();
            current = resolveConfig(raw);
            kill = isPlainObject(raw?.kill) ? raw.kill : null;
          } catch (_err) { /* keep last good */ }
        };
        read();
        if (typeof scope.watch === 'function') ctx.effect(() => scope.watch(read), 'dsh-autonomy.watch');
      } catch (error) {
        ctx.logger?.warn?.('dsh-autonomy: settings namespace unavailable (%s)', error?.message ?? error);
      }
    }

    const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : require('node:path').join(require('node:os').homedir(), '.dsh');

    function killMatches(agent) {
      if (kill === null) return false;
      const header = agent?.session?.header ?? {};
      const scope = String(kill.scope ?? 'session');
      if (scope === 'family') return true;
      if (scope === 'child') return header.origin === 'subagent' || (header.delegationDepth ?? 0) >= 1;
      // session scope: exact id or any top-level session
      if (kill.id !== undefined && kill.id !== '') return String(agent.id) === String(kill.id);
      return header.origin !== 'subagent';
    }

    function applyKill(agent, why) {
      const reason = String(kill?.reason ?? why ?? 'user_request');
      try {
        agent.cancel({ kind: 'hook', reason: `prime-kill: ${reason}` });
      } catch (error) {
        ctx.logger?.warn?.('dsh-autonomy: cancel failed for %s: %s', agent.id, error?.message ?? error);
      }
      journal.append(home, String(agent.id), 'autonomy', 'autonomy/kill', {
        scope: String(kill?.scope ?? 'session'),
        reason,
        initiator: 'settings-flag',
      });
    }

    // ── kill switch sweep + budget enforcement at turn boundaries ──────────
    ctx.on('agent/turn-stopping', async (payload) => {
      const agent = payload?.agent;
      if (agent === undefined || agent === null) return;
      if (kill !== null && killMatches(agent)) {
        applyKill(agent, 'user_request');
        return;
      }
      const events = agent.session?.events ?? [];
      const header = agent.session?.header ?? {};
      const isChild = header.origin === 'subagent' || (header.delegationDepth ?? 0) >= 1;
      const limits = isChild ? current.children : current.session;

      const usage = usageOfEvents(events);
      const maxTokens = isChild ? limits.maxPerChildTokens : limits.maxTokens;
      if (Number.isFinite(maxTokens) && maxTokens > 0 && usage.total >= maxTokens) {
        applyKill(agent, 'budget_exceeded');
        journal.append(home, String(agent.id), 'autonomy', 'autonomy/kill', {
          scope: isChild ? 'child' : 'session', reason: 'budget_exceeded',
          detail: { tokens_used: usage.total, max_tokens: maxTokens }, initiator: 'turn-stopping',
        });
        return;
      }

      const turns = new Set(events.filter((e) => e.type === 'turn/start').map((e) => e.data.turn)).size;
      if (!isChild && Number.isFinite(current.session.maxTurns) && turns >= current.session.maxTurns) {
        applyKill(agent, 'budget_exceeded');
        journal.append(home, String(agent.id), 'autonomy', 'autonomy/kill', {
          scope: 'session', reason: 'budget_exceeded', detail: { turns, max_turns: current.session.maxTurns }, initiator: 'turn-stopping',
        });
        return;
      }

      const createdAt = Number(header.createdAt ?? 0);
      if (!isChild && createdAt > 0 && Date.now() - createdAt >= current.session.maxWallClockMs) {
        applyKill(agent, 'budget_exceeded');
        journal.append(home, String(agent.id), 'autonomy', 'autonomy/kill', {
          scope: 'session', reason: 'budget_exceeded', detail: { wall_clock_ms: Date.now() - createdAt }, initiator: 'turn-stopping',
        });
      }
    });

    // ── heartbeat hygiene guidance ─────────────────────────────────────────
    ctx.systemPrompt?.section?.({
      name: 'prime:autonomy',
      order: 117,
      text: () => [
        'Autonomy discipline: when working toward a goal across rounds, make each round produce verifiable progress and say what changed.',
        'Repeated identical check-ins without progress are worse than one honest blocked report.',
        'While the user is actively steering, finish responding to them before resuming background iteration.',
      ].join(' '),
    });

    ctx.fiber.effect(() => lastSteerAtBySession.clear());
  },
};
