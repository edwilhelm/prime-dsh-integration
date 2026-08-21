// ============================================================================
// dsh-trajectory-refinement — the Continual Harness (plan §4.5)
// ============================================================================
// Deltas are ordered patch layers stored under
//   storages/prime/refinements/<id>.json
// Each layer: { id, scope, kind, target, content, evidence[], confidence,
//               created_at, ttl_days, status }.
//
// Governance (this build):
//   - Reserved namespaces (policy/approval/sandbox/auth/secret) are rejected
//     STRUCTURALLY through ctx.policy.rejectReserved() before anything else.
//   - Blast-radius tiers: session prompt notes apply automatically; skills and
//     sub-agent preset changes require canary; global promotion requires the
//     operator to flip `prime.refine.approveGlobal` — the model cannot.
//   - Canary-by-default: non-trivial layers mount in "shadow" mode first and
//     only activate after `prime-ops verify` shows no regression on a replayed
//     prefix; trivial prompt notes apply directly.
//   - Rollback-by-ID = status flip to rolled_back (layer deletion equivalent;
//     the file is kept for audit).
//   - Memory lifecycle: confidence + TTL + last_used; expired memories stop
//     being served. Self-improvement without forgetting is self-pollution.
//   - Every transition journals `refine/proposed|applied|rolled_back`.
//
// Layers surface as system-prompt sections (prompt notes / memories) and as
// skill-directory entries for code-backed kinds. Policy rows are FORBIDDEN
// targets by construction.
// ============================================================================
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const journal = require('../lib/journal.cjs');

const name = 'dsh-trajectory-refinement';

const inject = ['tools', 'policy', 'settings', 'systemPrompt'];

const TIERS = {
  'session-note': { risk: 'low', requirement: 'automatic' },
  'session-skill': { risk: 'medium', requirement: 'dry-run+canary' },
  'subagent-preset': { risk: 'medium-high', requirement: 'canary+human-approval' },
  'global-memory': { risk: 'high', requirement: 'human-approval' },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

module.exports = {
  name,
  inject,

  apply(ctx) {
    const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : path.join(os.homedir(), '.dsh');
    const root = path.join(home, 'storages', 'prime', 'refinements');
    fs.mkdirSync(root, { recursive: true });

    let approveGlobal = false;

    const settings = ctx.get('settings');
    if (settings && typeof settings.register === 'function') {
      try {
        const schema = function schema(value) {
          const src = isPlainObject(value) ? value : {};
          return { approveGlobal: src.approveGlobal === true };
        };
        schema.toJSON = () => ({
          type: 'object',
          properties: {
            approveGlobal: { type: 'boolean', description: 'Operator approval for high-risk global refinements. The model cannot set this.' },
          },
        });
        const scope = settings.register('prime.refine', schema, { base: { approveGlobal: false } });
        const read = () => {
          try {
            approveGlobal = scope.get()?.approveGlobal === true;
          } catch (_err) { /* keep */ }
        };
        read();
        if (typeof scope.watch === 'function') ctx.effect(() => scope.watch(read), 'dsh-refine.watch');
      } catch (_err) { /* optional */ }
    }

    const log = (message) => {
      try { ctx.logger?.warn?.(message); } catch (_err) { process.stderr.write(`${message}\n`); }
    };

    function fileOf(id) { return path.join(root, `${id}.json`); }

    function loadAll() {
      const out = [];
      for (const entry of fs.readdirSync(root)) {
        if (!entry.endsWith('.json')) continue;
        try {
          const layer = JSON.parse(fs.readFileSync(path.join(root, entry), 'utf8'));
          if (layer.status === 'active' || layer.status === 'shadow') out.push(layer);
        } catch (_err) { /* skip corrupt */ }
      }
      out.sort((a, b) => a.created_at - b.created_at);
      return out;
    }

    function activeLayers() {
      const now = Date.now();
      return loadAll().filter((layer) => {
        if (layer.status !== 'active') return false;
        if (Number.isFinite(layer.ttl_days) && layer.ttl_days > 0) {
          const expires = layer.created_at + layer.ttl_days * 86_400_000;
          if (now >= expires) return false; // forgetting policy: TTL expiry stops service
        }
        return true;
      });
    }

    function propose(sessionId, input) {
      const tier = TIERS[input.kind] === undefined ? null : input.kind;
      if (tier === null) throw new Error(`unknown refinement kind "${input.kind}" (${Object.keys(TIERS).join('|')})`);
      // Structural reserved-namespace rejection BEFORE any dry-run (§4.6).
      ctx.policy.rejectReserved(String(input.target ?? ''));
      const id = `ref_${crypto.createHash('sha256').update(`${Date.now()}:${input.target}:${input.content}`).digest('hex').slice(0, 12)}`;
      const requiresApproval = input.kind === 'global-memory';
      const needsCanary = input.kind !== 'session-note';
      const layer = {
        id,
        session: String(sessionId ?? ''),
        kind: input.kind,
        target: String(input.target ?? 'system-prompt'),
        content: String(input.content ?? '').slice(0, 20_000),
        evidence: Array.isArray(input.evidence) ? input.evidence.map((e) => String(e).slice(0, 120)).slice(0, 16) : [],
        confidence: Math.min(1, Math.max(0, Number(input.confidence ?? 0.5))),
        ttl_days: Number.isFinite(input.ttlDays) && input.ttlDays > 0 ? input.ttlDays : 30,
        status: requiresApproval ? 'proposed' : needsCanary ? 'shadow' : 'active',
        created_at: Date.now(),
      };
      if (requiresApproval && !approveGlobal) {
        journal.append(home, sessionId, 'refine', 'refine/proposed', { id, patch_layer: { kind: layer.kind, target: layer.target }, expected: 'awaiting-operator-approval', canary_result: null });
        fs.writeFileSync(fileOf(id), JSON.stringify(layer, null, 2), 'utf8');
        return { ...layer, note: 'global scope requires human approval: set prime.refine.approveGlobal=true, then re-propose' };
      }
      fs.writeFileSync(fileOf(id), JSON.stringify(layer, null, 2), 'utf8');
      journal.append(home, sessionId, 'refine', 'refine/proposed', { id, patch_layer: { kind: layer.kind, target: layer.target }, evidence: layer.evidence, expected: layer.status });
      if (layer.status === 'active') {
        journal.append(home, sessionId, 'refine', 'refine/applied', { id, patch_layer: { kind: layer.kind, target: layer.target }, canary_result: { skipped: 'trivial-tier' } });
      }
      return layer;
    }

    function rollback(sessionId, id) {
      const file = fileOf(id);
      if (!fs.existsSync(file)) throw new Error(`unknown refinement id ${id}`);
      const layer = JSON.parse(fs.readFileSync(file, 'utf8'));
      layer.status = 'rolled_back';
      layer.rolled_back_at = Date.now();
      fs.writeFileSync(file, JSON.stringify(layer, null, 2), 'utf8');
      journal.append(home, sessionId, 'refine', 'refine/rolled_back', { id, patch_layer: { kind: layer.kind, target: layer.target } });
      return layer;
    }

    // ── model-facing tools ──────────────────────────────────────────────────
    ctx.tools.register({
      name: 'refinement_propose',
      description: [
        'Propose one audited self-improvement from concrete session evidence (a lesson, a reusable skill step, a memory worth keeping across sessions of this project).',
        'Kinds: session-note (applies immediately), session-skill and subagent-preset (shadow until verified), global-memory (needs operator approval).',
        'Policy, approval, sandbox, auth, and secret configuration can never be proposed.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: Object.keys(TIERS), description: 'Blast-radius tier.' },
          target: { type: 'string', description: 'What this refines, e.g. "system-prompt", "skill:build", "memory:flaky-tests".' },
          content: { type: 'string', description: 'The refinement text itself (imperative, self-contained).' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'Event seqs or short citations backing it.' },
          confidence: { type: 'number', description: '0..1 confidence that this improves future behavior.' },
          ttlDays: { type: 'number', description: 'Days until the memory expires (default 30).' },
        },
        required: ['kind', 'target', 'content'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' }, status: { type: 'string' }, note: { type: 'string' },
          },
          required: ['id', 'status', 'note'],
          additionalProperties: false,
        },
        render(_args, value) { return [{ type: 'text', text: `refinement ${value.id}: ${value.status}. ${value.note}`.trim() }]; },
      },
      async execute(args, exec) {
        const sessionId = exec.agent?.id ?? 'unowned';
        const layer = propose(sessionId, args);
        return { id: layer.id, status: layer.status, note: layer.note ?? `tier=${layer.kind} requirement=${TIERS[layer.kind].requirement}` };
      },
      presentCall: (args) => ({ card: 'generic', title: `propose ${args.kind}`, kind: 'other', rawInput: String(args.target ?? '') }),
    });

    ctx.tools.register({
      name: 'refinement_rollback',
      description: 'Roll back one of your own earlier refinements by id (e.g. when evidence later shows it made things worse).',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Refinement id from refinement_propose.' } },
        required: ['id'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
          required: ['ok', 'message'],
          additionalProperties: false,
        },
        render(_args, value) { return [{ type: 'text', text: value.message }]; },
      },
      async execute(args, exec) {
        const sessionId = exec.agent?.id ?? 'unowned';
        try {
          const layer = rollback(sessionId, String(args.id ?? ''));
          return { ok: true, message: `rolled back ${layer.id} (${layer.kind})` };
        } catch (error) {
          return { ok: false, message: String(error.message ?? error) };
        }
      },
      presentCall: (args) => ({ card: 'generic', title: 'rollback refinement', kind: 'other', rawInput: String(args.id ?? '') }),
    });

    // ── serve active layers as prompt sections ─────────────────────────────
    ctx.systemPrompt.section({
      name: 'prime:refinements',
      order: 130,
      text: () => {
        const layers = activeLayers().filter((l) => l.session === '' || true); // session scoping refined in Phase 5
        if (layers.length === 0) return '';
        const parts = ['Learned refinements (audited, rollbackable; oldest first):'];
        for (const layer of layers.slice(-24)) {
          parts.push(`- [${layer.kind}] (${layer.id}, confidence ${layer.confidence.toFixed(2)}) ${layer.content}`);
        }
        return parts.join('\n');
      },
    });

    log('dsh-trajectory-refinement: serving audited refinement layers');
  },
};
