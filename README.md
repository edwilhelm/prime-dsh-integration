# prime-dsh-integration

[![ci](https://github.com/edwilhelm/prime-dsh-integration/actions/workflows/ci.yml/badge.svg)](https://github.com/edwilhelm/prime-dsh-integration/actions/workflows/ci.yml)

Prime Agent's five proven strengths — RLM architecture, Continual Harness
self-improvement, long-horizon autonomy, family-scoped orchestration, and
token efficiency — ported into **DeepSeek Harness (dsh)** as out-of-tree
plugins and profiles. Implements `prime-dsh-integration-plan-v3.md` against
dsh v0.1.x.

MIT-licensed (plan P9). No core modification, no fork: the stock dsh profiles
stay byte-for-byte untouched, adoption is selecting a profile (P1/P6), and
uninstalling is one script.

## Install

Requirements: [dsh](https://github.com/deepseek-ai/deepseek-harness) v0.1.x,
Node 22+, Python 3.10+ on PATH (for the persistent kernel).

Windows:

```powershell
git clone https://github.com/edwilhelm/prime-dsh-integration.git
cd prime-dsh-integration
powershell -ExecutionPolicy Bypass -File install.ps1
```

macOS / Linux:

```sh
git clone https://github.com/edwilhelm/prime-dsh-integration.git
cd prime-dsh-integration
./install.sh
```

The installer copies `plugins/prime`, the two `prime-*` profiles, and the
`prime-rlm` preset into your harness home (`$DSH_HOME` or `~/.dsh`), appends
the documented `prime:` settings section once (marker-delimited), and runs the
selftest. Re-running refreshes files in place.

Uninstall: `uninstall.ps1` / `./uninstall.sh` (add `-PurgeData` / `PURGE=1`
to also delete journals and artifacts under `storages/prime`).

## Use

```powershell
# headless: prime rows always active (kernel, budgets, caps, refinement)
dsh --profile prime-headless "implement and verify the auth flow"

# web: pick the "Prime RLM" preset per session, or make it the default:
#   agent-presets: { default: prime-rlm }   in settings.yaml
dsh --profile prime-web

# Code Mode presentation outside presets is dsh's own switch:
DSH_TOOLS_MODE=both dsh --profile prime-headless "..."
```

Operator CLI (offline; never calls a model):

```powershell
node ~\.dsh\plugins\prime\tools\prime-ops.cjs selftest
node ~\.dsh\plugins\prime\tools\prime-ops.cjs verify <sessionId>
node ~\.dsh\plugins\prime\tools\prime-ops.cjs kernel inspect <sessionId>
node ~\.dsh\plugins\prime\tools\prime-ops.cjs refine history <sessionId>
node ~\.dsh\plugins\prime\tools\prime-import.cjs --source <primeHome> --dry-run
```

## What's inside

| Path | Plan § | What it is |
|---|---|---|
| `plugins/prime/dsh-policy/` | §4.6 | `ctx.policy`: action classes, reserved-namespace rejection, child sub-budgets, kernel→approval routing |
| `plugins/prime/dsh-kernel/` | §4.1 | Persistent Python kernel (`python_exec`), effect journal, env scrubbing + output redaction, artifact store, retrieval helpers |
| `plugins/prime/dsh-loop-rlm/` | §4.2 | Envelope QC on `agent/pre-step`, context snapshots, user-interrupt records, fallback router driven by `model-capability.yml` |
| `plugins/prime/dsh-autonomy/` | §4.4 | Hierarchical budgets at `agent/turn-stopping`, hot-reload kill switch, heartbeat guidance |
| `plugins/prime/dsh-orchestration/` | §4.3 | Spawn concurrency caps, dead-letter journal, budget inheritance, cancel propagation |
| `plugins/prime/dsh-trajectory-refinement/` | §4.5 | Patch layers with blast-radius tiers, canary/shadow-by-default, rollback-by-id, TTL memory lifecycle |
| `plugins/prime/dsh-prime-ops/` + `plugins/prime/tools/` | §4.8/§4.9 | `prime_status` tool; offline verifier; one-way Prime Agent importer; three-arm benchmark rig |
| `plugins/prime/model-capability.yml` | §3 | Model matrix with `rlm_ready` gates consumed by the fallback router |
| `plugins/prime/benchmarks/tasks.md` | §3 | Baseline + adversarial task suite |

Design decisions forced by the host build, verification evidence, and the
upstreaming path (§12) are documented in
[`plugins/prime/README.md`](plugins/prime/README.md).

## Verification

Every behavioral surface has a standalone check that exercises the shipped
plugin code (stubbed Cordis context where host services would be needed):

```powershell
node tools\prime-ops.cjs selftest                  # modules + kernel protocol round-trip
node tools\kernel-security-check.cjs               # env scrubbing, output redaction (adv-03)
node tools\refinement-governance-check.cjs         # reserved namespaces (adv-02), tiers, rollback
node tools\autonomy-check.cjs                      # kill switch, budgets, sub-budget inheritance
node tools\orchestration-check.cjs                 # caps, dead letters, cancel propagation
node tools\rlm-loop-check.cjs                      # snapshots, verbatim user text, degrade-once router
```

All green as of 2026-08-21, plus live headless boots with persistent-kernel
tool calls on dsh v0.1.0-rc.7 / Node 22.15 / Python 3.13 / Windows. CI runs
the same suite on Windows and Linux plus an installer round-trip on every
push.

Because the integration lives in two places (repo + installed harness home),
check for drift before pushing or after editing either side:

```sh
node scripts/drift-check.cjs
```

## Known limitations

- New durable events live in append-only sidecar journals
  (`storages/prime/<session>/*.jsonl`) because this dsh build refuses unknown
  session-event types on resume; upstreaming them into `SessionEventMap` is
  the §12 PR path.
- The Python kernel process is not yet jailed: policy-gated helpers cover the
  sanctioned surface, but raw `os.system` inside python bypasses approval
  (tracked by benchmarks adv-06 until sandbox wiring lands).
- Family messaging transport (priorities/arrows) is cap+journal only for now.
