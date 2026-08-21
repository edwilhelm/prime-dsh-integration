// ============================================================================
// dsh-policy — the shared policy service (plan §4.6)
// ============================================================================
// One enforcement point, three consumers, shipped as a plain provided service
// (`ctx.policy`) rather than a god-service (P3):
//
//   kernel (P10)      classifies kernel-callable actions safe/dangerous/
//                     forbidden; dangerous ones route through ctx.approval
//                     with the session's own approval policy — identical to
//                     the model-facing tools.
//   refinement (§4.5) rejectReserved() refuses patch layers targeting
//                     reserved namespaces BEFORE any dry-run.
//   orchestration     childBudget() derives explicit sub-budgets from the
//                     parent's remainder at spawn time (P12).
//
// Reserved namespaces are structural: no refinement path may ever write them.
// ============================================================================
'use strict';

const name = 'dsh-policy';

const inject = ['settings'];

const RESERVED_NAMESPACES = ['policy', 'approval', 'sandbox', 'auth', 'secret'];

const DEFAULTS = {
  // Action classes for kernel-callable capabilities (P10). 'dangerous' asks;
  // 'forbidden' never runs from inside the kernel regardless of policy.
  classes: {
    'shell.exec': 'dangerous',
    'file.write': 'dangerous',
    'file.read': 'safe',
    'web.fetch': 'dangerous',
    'net.connect': 'forbidden',
    'pip.install': 'dangerous',
  },
  children: {
    maxTotalTokens: 1_000_000,
    maxPerChildTokens: 250_000,
    maxConcurrency: 4,
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveConfig(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const classes = { ...DEFAULTS.classes, ...(isPlainObject(src.classes) ? src.classes : {}) };
  const children = { ...DEFAULTS.children, ...(isPlainObject(src.children) ? src.children : {}) };
  return { classes, children };
}

module.exports = {
  name,
  inject,
  apply(ctx, config) {
    const resolved = resolveConfig(config);

    let current = resolved;
    const settings = ctx.get('settings');
    if (settings && typeof settings.register === 'function') {
      try {
        const schema = function schema(value) {
          const out = resolveConfig(value);
          return { classes: out.classes, children: out.children };
        };
        schema.toJSON = () => ({
          type: 'object',
          properties: {
            classes: { type: 'object', description: 'Kernel-callable action → safe | dangerous | forbidden.' },
            children: {
              type: 'object',
              properties: {
                maxTotalTokens: { type: 'number', description: 'Family-wide token ceiling for spawned children (P12).' },
                maxPerChildTokens: { type: 'number', description: 'Default per-child token sub-budget.' },
                maxConcurrency: { type: 'number', description: 'Max live children per parent.' },
              },
            },
          },
        });
        const scope = settings.register('prime.policy', schema, { base: resolved });
        const read = () => {
          try {
            current = resolveConfig(scope.get());
          } catch (_err) {
            current = resolved;
          }
        };
        read();
        if (typeof scope.watch === 'function') ctx.effect(() => scope.watch(read), 'dsh-policy.watch');
      } catch (error) {
        ctx.logger?.warn?.('dsh-policy: settings namespace unavailable (%s); using row config', error?.message ?? error);
      }
    }

    const policy = {
      /** True when the namespace is refinement-forbidden (structural check). */
      isReserved(namespace) {
        const ns = String(namespace ?? '').replace(/^prime\./, '');
        return RESERVED_NAMESPACES.some((reserved) => ns === reserved || ns.startsWith(`${reserved}.`));
      },

      /** Names of every reserved namespace, for diagnostics and tests. */
      reservedNamespaces() {
        return [...RESERVED_NAMESPACES];
      },

      /**
       * Structural rejection used by refinement before dry-run. Throws when
       * the patch targets a reserved namespace; returns the checked target.
       */
      rejectReserved(target) {
        if (this.isReserved(target)) {
          throw new Error(`dsh-policy: refinement target "${target}" is a reserved namespace and can never be patched`);
        }
        return target;
      },

      /** Classify one kernel-callable action. */
      classify(action) {
        return current.classes[action] ?? 'dangerous';
      },

      /**
       * Enforce one kernel-callable action for an agent (P10). Safe resolves
       * immediately; dangerous routes through the session's OWN approval
       * service (identical surface to model-facing tools); forbidden throws.
       * Requires an open turn on the requesting agent (approval audit pair).
       */
      async authorize(agent, action, reason) {
        const klass = this.classify(action);
        if (klass === 'forbidden') {
          throw new Error(`dsh-policy: "${action}" is forbidden inside the kernel`);
        }
        if (klass === 'safe') return true;
        const approval = ctx.get('approval');
        if (!approval || typeof approval.request !== 'function') {
          throw new Error(`dsh-policy: "${action}" requires approval but no approval service is mounted (fail closed)`);
        }
        const outcome = await approval.request({
          agent,
          toolName: `kernel:${action}`,
          reason: reason ?? `kernel-requested ${action}`,
        });
        if (outcome !== 'allowed-once') {
          throw new Error(`dsh-policy: kernel "${action}" was not approved (${outcome})`);
        }
        return true;
      },

      /**
       * Derive a child's explicit sub-budget from the parent's remainder
       * (P12). Never returns unbounded values; callers must attach the whole
       * result to the spawn.
       */
      childBudget(parentRemaining) {
        const remaining = Math.max(0, Number(parentRemaining) || 0);
        const perChild = Math.min(current.children.maxPerChildTokens, current.children.maxTotalTokens);
        return {
          maxTokens: perChild,
          maxTotalTokens: current.children.maxTotalTokens,
          maxConcurrency: current.children.maxConcurrency,
          derivedFrom: remaining > 0 ? Math.min(remaining, perChild) : perChild,
          inheritedAt: Date.now(),
        };
      },

      /** Live view for prime_status / ops. */
      describe() {
        return {
          reserved: [...RESERVED_NAMESPACES],
          classes: { ...current.classes },
          children: { ...current.children },
        };
      },
    };

    ctx.provide('policy', policy);
  },
};
