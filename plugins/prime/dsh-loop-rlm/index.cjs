// ============================================================================
// dsh-loop-rlm — the RLM driver (plan §4.2)
// ============================================================================
// On this dsh build the RLM mechanism composes from three pieces:
//
//   1. Presentation: the `prime-rlm` preset flips tool presentation to Code
//      Mode via dsh's own agent-plane row (`presentAs('code')`) — programmatic
//      tool calling is a HOST capability here, not something this plugin
//      rebuilds (P7). `python_exec` + retrieval helpers ride along as ordinary
//      tools, reachable natively and from inside programs.
//
//   2. Envelope quality control (this file): every step, measure the model-
//      visible envelope, journal an `rlm/context-snapshot`, and enforce the
//      invariants that matter:
//        - raw user instructions are NEVER rewritten (the plugin does not
//          transform message content; durable compaction stays with
//          dsh-compaction-basic, which owns safe surface replacement);
//        - pinned facts (settings `prime.rlm.pinnedFacts`) are restated in
//          the prompt section so compaction cannot lose them;
//        - context is PULLED on demand through history_search / turns_last /
//          vars_describe instead of pushed wholesale into the envelope.
//
//   3. Fallback router (P13): watches kernel/tool failure rates and the
//      model-capability matrix (`rlm_ready`); degrades observably and
//      journals `rlm/fallback`. State is never lost: degradation switches
//      measurement and guidance, never the session.
//
// User-interrupt semantics: a user message claimed at step > 1 of a turn is
// journaled as `rlm/user-interrupt` (steering proxy), and heartbeats pause
// while steering is recent (consumed by dsh-autonomy).
// ============================================================================
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const journal = require('../lib/journal.cjs');

const name = 'dsh-loop-rlm';

const inject = ['settings', 'systemPrompt'];

const DEFAULTS = {
  enabled: true,
  envelopeWarnChars: 120_000,
  envelopeBudgetChars: 400_000,
  errorWindow: 8,
  errorThreshold: 5,
  capabilityFile: 'model-capability.yml',
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function resolveConfig(raw) {
  const src = isPlainObject(raw) ? raw : {};
  return {
    enabled: src.enabled !== false,
    envelopeWarnChars: Number.isFinite(src.envelopeWarnChars) && src.envelopeWarnChars > 0 ? src.envelopeWarnChars : DEFAULTS.envelopeWarnChars,
    envelopeBudgetChars: Number.isFinite(src.envelopeBudgetChars) && src.envelopeBudgetChars > 0 ? src.envelopeBudgetChars : DEFAULTS.envelopeBudgetChars,
    errorWindow: Number.isFinite(src.errorWindow) && src.errorWindow > 0 ? src.errorWindow : DEFAULTS.errorWindow,
    errorThreshold: Number.isFinite(src.errorThreshold) && src.errorThreshold > 0 ? src.errorThreshold : DEFAULTS.errorThreshold,
    capabilityFile: typeof src.capabilityFile === 'string' && src.capabilityFile !== '' ? src.capabilityFile : DEFAULTS.capabilityFile,
  };
}

// ---------------------------------------------------------------------------
// minimal YAML-subset reader for model-capability.yml (no external deps):
// nested maps by indentation, scalars, inline one-level flow maps, comments.
// ---------------------------------------------------------------------------

function parseScalar(text) {
  const t = text.trim();
  if (t === 'null' || t === '~' || t === '') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d*\.\d+$/.test(t)) return parseFloat(t);
  return t.replace(/^['"]|['"]$/g, '');
}

function parseFlowMap(text) {
  const out = {};
  const body = text.trim().replace(/^\{/, '').replace(/\}$/, '');
  for (const pair of body.split(',')) {
    const idx = pair.indexOf(':');
    if (idx < 0) continue;
    out[pair.slice(0, idx).trim()] = parseScalar(pair.slice(idx + 1));
  }
  return out;
}

function parseCapabilityYaml(text) {
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').replace(/\s+$/, '');
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    const idx = trimmed.indexOf(':');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const valueText = trimmed.slice(idx + 1).trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (valueText === '') {
      const child = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else if (valueText.startsWith('{')) {
      parent[key] = parseFlowMap(valueText);
    } else {
      parent[key] = parseScalar(valueText);
    }
  }
  return root;
}

module.exports = {
  name,
  inject,

  apply(ctx, config) {
    let current = resolveConfig(config);

    const settings = ctx.get('settings');
    let pinnedFacts = [];
    if (settings && typeof settings.register === 'function') {
      try {
        const schema = function schema(value) {
          const src = isPlainObject(value) ? value : {};
          return {
            enabled: src.enabled !== false,
            envelopeWarnChars: current.envelopeWarnChars,
            envelopeBudgetChars: current.envelopeBudgetChars,
            errorWindow: current.errorWindow,
            errorThreshold: current.errorThreshold,
            capabilityFile: current.capabilityFile,
            pinnedFacts: Array.isArray(src.pinnedFacts) ? src.pinnedFacts.map(String) : [],
          };
        };
        schema.toJSON = () => ({
          type: 'object',
          properties: {
            enabled: { type: 'boolean', description: 'Master switch for RLM measurement and guidance.' },
            envelopeWarnChars: { type: 'number', description: 'Envelope size where warnings begin.' },
            envelopeBudgetChars: { type: 'number', description: 'Envelope size where fallback signals fire.' },
            pinnedFacts: { type: 'array', description: 'Must-survive-compaction facts restated every step.' },
          },
        });
        const scope = settings.register('prime.rlm', schema, { base: { enabled: current.enabled, pinnedFacts: [] } });
        const read = () => {
          try {
            const merged = resolveConfig(scope.get());
            current = merged;
            const raw = scope.get();
            pinnedFacts = Array.isArray(raw?.pinnedFacts) ? raw.pinnedFacts.map(String) : [];
          } catch (_err) { /* keep last good */ }
        };
        read();
        if (typeof scope.watch === 'function') ctx.effect(() => scope.watch(read), 'dsh-loop-rlm.watch');
      } catch (error) {
        ctx.logger?.warn?.('dsh-loop-rlm: settings namespace unavailable (%s)', error?.message ?? error);
      }
    }

    // Model capability gate (Phase-0 artifact). Missing file → permissive but
    // unmeasured; the router still watches live error rates.
    const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : path.join(os.homedir(), '.dsh');
    const capabilityPath = path.join(home, 'plugins', 'prime', current.capabilityFile);
    let capabilities = { defaults: { rlm_ready: false, fallback_mode: 'standard' }, models: {} };
    try {
      capabilities = parseCapabilityYaml(fs.readFileSync(capabilityPath, 'utf8'));
    } catch (_err) { /* keep defaults */ }
    function capabilityFor(provider, model) {
      const direct = capabilities.models?.[`${provider}/${model}`];
      if (direct !== undefined && direct !== null) return direct;
      return capabilities.defaults ?? { rlm_ready: false, fallback_mode: 'standard' };
    }

    // Per-session router state.
    const state = new Map(); // sessionId -> { outcomes: [], degraded: bool, warned: bool }
    function stateFor(id) {
      let s = state.get(id);
      if (s === undefined) {
        s = { outcomes: [], degraded: false, warnedReady: false, warnedPressure: false, lastUserSteerAt: 0 };
        state.set(id, s);
      }
      return s;
    }

    function envelopeChars(events) {
      let total = 0;
      for (const event of events) {
        if (event.type === 'assistant/chunk') continue;
        try { total += JSON.stringify(event.data).length; } catch (_err) { /* skip */ }
      }
      return total;
    }

    // ── pre-step projection point ──────────────────────────────────────────
    ctx.on('agent/pre-step', (payload, next) => {
      return Promise.resolve(next()).then((decision) => {
        if (decision === undefined || decision === null || decision.kind !== 'enter') return decision;
        const agent = payload?.agent;
        const sessionId = String(agent?.id ?? 'unknown');
        const s = stateFor(sessionId);

        // Raw-user-interrupt proxy: a direct human message claimed at step > 1.
        const step = Number(payload?.step ?? 0);
        for (const message of decision.messages ?? []) {
          if (message?.source?.kind === 'user' && step > 1) {
            s.lastUserSteerAt = Date.now();
            journal.append(home, sessionId, 'rlm', 'rlm/user-interrupt', {
              message_ref: message.source?.summary ?? '(user message)',
              steering: true,
              turn: payload.turn,
              step,
            });
          }
        }

        if (!current.enabled || s.degraded) return decision;

        const events = agent?.session?.events ?? [];
        const chars = envelopeChars(events) + (decision.messages ?? []).reduce((acc, m) => acc + JSON.stringify(m).length, 0);

        // Fallback signals: envelope pressure + recent outcome window.
        // Route identity: the durable request/context fold when present, else
        // the agent's creation options (first step has no context event yet).
        const route = agent?.session?.requestContext?.() ?? (agent?.options ? { provider: agent.options.provider ?? '', model: agent.options.model ?? '' } : {});
        const cap = capabilityFor(route?.provider ?? '', route?.model ?? '');
        if (cap.rlm_ready === false && !s.warnedReady) {
          s.warnedReady = true;
          journal.append(home, sessionId, 'rlm', 'rlm/fallback', {
            reason: 'model-not-rlm-ready', provider: route?.provider ?? '?', model: route?.model ?? '?',
            fallback_mode: cap.fallback_mode ?? 'standard', action: 'observational',
          });
          ctx.logger?.warn?.('dsh-loop-rlm: model %s/%s is not rlm_ready; consider %s mode', route?.provider, route?.model, cap.fallback_mode);
        }
        if (chars > current.envelopeBudgetChars && !s.warnedPressure) {
          s.warnedPressure = true;
          journal.append(home, sessionId, 'rlm', 'rlm/fallback', {
            reason: 'envelope-over-budget', envelope_chars: chars, budget: current.envelopeBudgetChars, action: 'observational',
          });
          ctx.logger?.warn?.('dsh-loop-rlm: envelope %d chars exceeds budget %d; rely on history_search pulls and compaction', chars, current.envelopeBudgetChars);
        }

        journal.append(home, sessionId, 'rlm', 'rlm/context-snapshot', {
          event_range: { from: events[0]?.seq ?? 0, to: events[events.length - 1]?.seq ?? 0 },
          envelope_chars: chars,
          message_count: (decision.messages ?? []).length,
          pinned_facts: pinnedFacts.length,
          rlm_ready: cap.rlm_ready === true,
        });
        return decision;
      });
    });

    // ── outcome tracking for the router ────────────────────────────────────
    ctx.on('session/event', (_session, event) => {
      if (event.type !== 'tool/result') return;
      const failed = event.data?.message?.isError === true || event.data?.error !== undefined;
      const sessionId = String(_session?.id ?? 'unknown');
      const s = stateFor(sessionId);
      s.outcomes.push(failed);
      if (s.outcomes.length > current.errorWindow) s.outcomes.shift();
      const failures = s.outcomes.filter(Boolean).length;
      if (!s.degraded && s.outcomes.length >= current.errorWindow && failures >= current.errorThreshold) {
        s.degraded = true;
        journal.append(home, sessionId, 'rlm', 'rlm/fallback', {
          reason: 'repeated-tool-failures', window: s.outcomes.length, failures,
          action: 'degraded-measurement+guidance', note: 'session state preserved; preset switch remains operator-owned (P13)',
        });
        ctx.logger?.warn?.('dsh-loop-rlm: %d/%d recent tool calls failed; RLM guidance degraded for %s', failures, s.outcomes.length, sessionId);
      }
    });

    // ── prompt sections ────────────────────────────────────────────────────
    ctx.systemPrompt?.section?.({
      name: 'prime:rlm-envelope',
      order: 116,
      text: () => {
        const parts = [
          'Context discipline: the conversation envelope is a budget.',
          'Pull specific context on demand with history_search / turns_last instead of re-reading; store large outputs with artifact_put and reference ids.',
          'Raw user instructions are authoritative and always preserved verbatim.',
        ];
        if (pinnedFacts.length > 0) parts.push(`Pinned facts that must survive any compaction: ${pinnedFacts.map((f) => `"${f}"`).join('; ')}.`);
        return parts.join(' ');
      },
    });

    ctx.fiber.effect(() => state.clear());
  },
};
