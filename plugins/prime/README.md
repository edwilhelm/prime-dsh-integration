# prime — Prime Agent × DeepSeek Harness integration (out-of-tree)

Implementation of `prime-dsh-integration-plan-v3.md` against the installed
dsh v0.1.0-rc.7. Everything here is **out-of-tree** (P1): no Cordis kernel
change, no fork, no default-profile modification (P6). Adoption = selecting
the `prime-web` / `prime-headless` profile and the `prime-rlm` agent preset.

## Layout

| Path | Plan § | What it is |
|---|---|---|
| `dsh-policy/index.cjs` | §4.6 | `ctx.policy` shared service: action classes, reserved-namespace guard, child sub-budget computation, kernel→approval routing |
| `dsh-kernel/kernel-python.cjs` | §4.1 | Persistent Python kernel service (`primeKernel`): exec/vars/destroy, effect journal, env-digest redaction, GC, execution limits |
| `dsh-kernel/artifacts.cjs` | §4.1 | Hash-addressed artifact store (`ctx.artifacts`) under `storages/prime/artifacts/` |
| `dsh-kernel/tools.cjs` | §4.1/§4.2 | Model-facing consumer seam: `python_exec`, retrieval helpers (`history_search`, `turns_last`, `vars_describe`, `artifacts_get`, `artifact_put`) |
| `dsh-loop-rlm/index.cjs` | §4.2 | RLM driver: `agent/pre-step` envelope QC (raw user text verbatim, pinned facts, size budget), context-snapshot journal, user-interrupt semantics, fallback router (P13) |
| `dsh-autonomy/index.cjs` | §4.4 | Hierarchical budgets on `agent/turn-stopping`, kill switch via hot-reloaded settings (<2s target), heartbeat hygiene on `ctx.jobs` |
| `dsh-orchestration/index.cjs` | §4.3 | Spawn concurrency caps, per-child budget inheritance (P12), dead-letter journal for denied spawns |
| `dsh-trajectory-refinement/index.cjs` | §4.5 | Continual Harness: ordered patch layers as prompt/skill refinements, blast-radius tiers, reserved-namespace rejection via ctx.policy, rollback-by-id, memory lifecycle, audit journal |
| `dsh-prime-ops/index.cjs` | §4.8 | In-session `prime_status` observability tool |
| `tools/prime-ops.mjs` | §4.8/P14 | Offline CLI: `verify` (replay/fork/effect-journal equality), `refine history/show/rollback`, `kernel inspect`, `family tree` |
| `tools/prime-import.mjs` | §4.9 | One-way Prime Agent → dsh importer with 100%-completeness migration report |
| `tools/prime-bench.mjs` | §3 | Three-arm benchmark rig skeleton (control / default loop / RLM), model-pinned, adversarial tasks included |
| `model-capability.yml` | §3 | Model capability matrix consumed by the RLM gate (`rlm_ready`, `fallback_mode`) |
| `benchmarks/tasks.md` | §3 | Baseline + adversarial task suite (injection, exfiltration lures, fakeable gates) |

Profiles: `~/.dsh/profiles/prime-web/`, `~/.dsh/profiles/prime-headless/`.
Preset: `~/.dsh/.agent-presets/prime-rlm/`. Flags/budgets: the `prime:`
section of `~/.dsh/settings.yaml` (hot-reloaded).

## Selecting the RLM loop

- **Web**: sessions pick the `Prime RLM` preset in the session picker, or set
  the default in `settings.yaml`:
  `agent-presets: { default: prime-rlm }`.
- **Headless**: the one-shot driver creates agents WITHOUT joining a preset
  (verified in `dsh-headless/lib/index.js run()`), so headless sessions get
  the prime profiles' host-plane rows (kernel, envelope QC, budgets, caps,
  refinement) with native tool presentation. Code Mode presentation there is
  dsh's own deployment switch: `DSH_TOOLS_MODE=both|code`. The benchmark
  rig's `rlm` arm uses exactly that.

## Design decisions forced by the host build (v0.1.0-rc.7)

1. **Sidecar journals instead of new session-event types (P4 adaptation).**
   The persistence coordinator refuses logs containing event types unknown to
   the build unless the envelope carries `ignorable: true`, and
   `Session.append()` cannot set that marker; the upstream registration
   surface for plugin events is documented as deferred. Until the §12 PR
   lands, every new durable record (`rlm/context-snapshot`, `kernel/effect`,
   `kernel/redaction`, `family/dead-letter`, `refine/*`, `autonomy/kill`)
   is an append-only JSONL sidecar under
   `storages/prime/<sessionId>/<family>.jsonl`. P4's substance — every
   model-visible input reconstructable — is preserved and *checked*:
   `node tools/prime-ops.mjs verify <sessionId>` validates log+sidecar
   consistency, effect-journal fork safety, and snapshot coverage.

2. **The kernel completes dsh's own code-execution seam (P5/P7/P8).** dsh
   ships Code Mode (`run_code`) with a TypeScript worker runtime and a full
   Python SDK renderer, but no Python backend. This integration provides the
   missing persistent-Python substrate as the `primeKernel` service with a
   model-facing `python_exec` tool — stateful across execs, which is exactly
   the prompt-as-variable property RLM needs and the per-run worker
   deliberately does not have. IPython-style persistence without a Jupyter
   dependency; `kernel-v8` remains the separately-validated alternative path
   (the stock TS worker), never assumed equivalent (P8).

3. **RLM presentation = dsh Code Mode + kernel tools.** The `prime-rlm`
   preset flips tool presentation to `code` via dsh's own agent-plane row;
   `python_exec` and the retrieval helpers register as ordinary tools so they
   are reachable both natively and from inside `run_code` programs through
   the generated SDK. The preset ships `both` by default (native schemas +
   SDK) so the kernel stays directly callable; `prime.flags.code_only`
   collapses to pure Code Mode once validated.

4. **Least privilege inside the kernel (P10).** Kernel-side shell/file/net
   helpers route through `ctx.policy`; dangerous actions call
   `ctx.approval.request()` — the same approval surface and policy as
   model-facing tools. `python_exec` cannot bypass what `shell` would ask.

5. **Refinement cannot touch policy (§4.6).** Patch layers targeting
   `policy.*`, `approval.*`, `sandbox.*`, `auth.*`, `secret.*` are rejected
   structurally, before any dry-run, by `ctx.policy.rejectReserved()`.

## Not yet implemented (deliberate, per plan exclusions)

- Family messaging transport (§4.3 message priorities/arrows): v0.1 enforces
  caps, budgets, cancellation propagation and dead-letter journals at the
  existing subagent seam; a dedicated family bus is out-of-tree Phase 4 work.
- Canary fork-replay for refinements runs against recorded sessions via
  `prime-ops verify`; live fork canary awaits the benchmark rig.
- Holdout evaluation set replays are wired in `prime-bench.mjs` but need the
  Phase-0 baseline run to become meaningful.
- Release channels are flag presets in `settings.yaml` (`prime.channel`),
  not a separate distribution mechanism.

## Verification status

Run after any change (all green as of 2026-08-21):

```powershell
node tools\prime-ops.cjs selftest                        # modules load; kernel protocol round-trip
node tools\kernel-security-check.cjs                     # env scrubbing (adv-03), output redaction, digest-only exposure
node tools\refinement-governance-check.cjs               # reserved-namespace rejection (adv-02), tiers, rollback, audit
node tools\autonomy-check.cjs                            # kill switch via settings watch, token/turn budgets, child sub-budgets
node tools\orchestration-check.cjs                       # spawn caps at N/N, dead letters, budget inheritance, cancel propagation
node tools\rlm-loop-check.cjs                            # snapshots with real route identity, verbatim user text, router degrade-once
node tools\prime-ops.cjs verify <sessionId>              # P4 invariants over log + sidecars
dsh --profile prime-headless "say hi"                    # live boot test
```

Live evidence from this machine: two headless boots completed real turns;
`python_exec` ran across calls with persistent state (effect journal: pure
execs with result digests; second call 1ms — warm kernel); RLM snapshots
tracked envelope growth 1.9k → 46k chars and resolved the route's `rlm_ready`
flag; `verify` passes on the resulting sessions. The autonomy/orchestration/
rlm checks exercise the shipped plugin code through stubbed Cordis contexts
(listener registration semantics verified against cordis dispatch source:
root-level listeners receive agent-scoped emits; fused dispatcher injects
`agent` into every payload).
