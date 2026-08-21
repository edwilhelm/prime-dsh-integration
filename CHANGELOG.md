# Changelog

All notable changes to the prime dsh integration. Format: Keep a Changelog;
versioning: SemVer.

## 0.1.0 — 2026-08-21

Initial release. Implements `prime-dsh-integration-plan-v3.md` against dsh
v0.1.x as out-of-tree plugins and profiles (no core modification).

### Added

- `dsh-policy`: shared `ctx.policy` service — kernel action classes,
  structural reserved-namespace rejection, child sub-budget computation,
  kernel→approval routing.
- `dsh-kernel`: persistent per-session Python kernel (`python_exec`) with
  effect journal (pure / read-only / side-effecting / non-deterministic),
  fork-at-N replay safety, env scrubbing + output redaction + digest-only
  environment exposure, hash-addressed artifact store, retrieval helpers
  (`history_search`, `turns_last`, `vars_describe`, `artifact_put`,
  `artifacts_get`).
- `dsh-loop-rlm`: envelope quality control on `agent/pre-step`, context
  snapshot journals, user-steering records, fallback router driven by
  `model-capability.yml` (`rlm_ready`) and live tool-failure rates.
- `dsh-autonomy`: hierarchical token/turn/wall-clock budgets enforced at
  `agent/turn-stopping`, hot-reloadable kill switch, heartbeat guidance.
- `dsh-orchestration`: spawn concurrency caps via monotonic guard,
  dead-letter journal, budget inheritance records, parent-cancel propagation.
- `dsh-trajectory-refinement`: audited patch layers with blast-radius tiers,
  canary/shadow-by-default, operator-gated global scope, rollback-by-id,
  TTL/confidence memory lifecycle.
- `dsh-prime-ops` + CLI: `prime_status` tool; offline verifier
  (`verify`/`refine`/`kernel inspect`/`family tree`); one-way Prime Agent
  importer with completeness report; three-arm benchmark rig skeleton.
- Profiles `prime-web` / `prime-headless`; agent preset `prime-rlm`;
  marker-delimited settings section; model capability matrix; adversarial
  benchmark task suite.
- Installers for Windows (PowerShell) and POSIX (sh), drift guard, CI
  (syntax + behavioral checks on Windows/Linux, installer round-trip).

### Known limitations

- New durable events live in append-only sidecar journals until upstream
  lands a plugin event-registration surface (§12 PR path).
- The Python kernel process is not yet jailed: raw `os.system` inside python
  bypasses approval (benchmarks adv-06).
- Family messaging transport is caps + journals only in this release.
