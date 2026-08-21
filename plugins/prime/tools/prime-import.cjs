#!/usr/bin/env node
// ============================================================================
// prime-import — one-way Prime Agent → dsh migration (plan §4.9)
// ============================================================================
// Maps Prime Agent durable state onto dsh destinations and writes a
// completeness report; 100% report completeness is the metric, never silent
// drops. One-way only: nothing here exports back to Prime format.
//
//   node prime-import.cjs --source <primeHome> [--dry-run]
//
// Mapping:
//   session JSONL      → archived under storages/prime/imported/sessions/
//                        (replay into live sessions is a manual step)
//   memories           → refinement layers kind=global-memory, status=proposed
//                        (provenance + confidence preserved; operator approves)
//   skills             → copied to ~/.dsh/skills/<name>/ when present
//   prompt notes       → refinement layers kind=session-note, status=active,
//                        target=system-prompt
//   sub-agent specs    → reported only (dsh presets are compositions; auto-
//                        generation is Phase-6 work) → report entry
//   refinement history → read-only audit import, NOT re-applied
// ============================================================================
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME
  : path.join(os.homedir(), '.dsh');

function fail(message) {
  process.stderr.write(`prime-import: ${message}\n`);
  process.exit(1);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try { out.push(JSON.parse(line)); } catch (_err) { out.push({ unparsable: line.slice(0, 120) }); }
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const sourceIdx = argv.indexOf('--source');
  const source = sourceIdx >= 0 ? path.resolve(argv[sourceIdx + 1] ?? '') : '';
  if (source === '' || !fs.existsSync(source)) {
    fail(`pass --source <primeHome> (a directory containing sessions/, memories/, skills/, ...)`);
  }

  const report = { source, dry_run: dryRun, imported: [], unsupported: [], counts: {} };
  const importDir = path.join(HOME, 'storages', 'prime', 'imported');
  const refineRoot = path.join(HOME, 'storages', 'prime', 'refinements');

  // ── sessions ──────────────────────────────────────────────────────────────
  const sessionsDir = path.join(source, 'sessions');
  let sessionCount = 0;
  if (fs.existsSync(sessionsDir)) {
    const destSessions = path.join(importDir, 'sessions');
    for (const entry of fs.readdirSync(sessionsDir)) {
      const from = path.join(sessionsDir, String(entry));
      if (!fs.statSync(from).isFile()) continue;
      sessionCount += 1;
      if (!dryRun) {
        fs.mkdirSync(destSessions, { recursive: true });
        fs.copyFileSync(from, path.join(destSessions, String(entry)));
      }
    }
    report.imported.push({ what: 'session JSONL files', count: sessionCount, destination: 'storages/prime/imported/sessions/ (archived; replay manually)' });
  } else {
    report.unsupported.push({ what: 'sessions/', reason: 'no sessions directory found in source' });
  }
  report.counts.sessions = sessionCount;

  // ── memories → global-memory refinement layers (proposed) ────────────────
  const memoryCandidates = ['memories.jsonl', 'memories.json', 'memory.jsonl'];
  let memoryCount = 0;
  for (const name of memoryCandidates) {
    const file = path.join(source, name);
    if (!fs.existsSync(file)) continue;
    for (const memory of readJsonl(file)) {
      memoryCount += 1;
      const id = `imp_mem_${String(memoryCount).padStart(4, '0')}`;
      const layer = {
        id,
        session: '',
        kind: 'global-memory',
        target: `memory:${String(memory.id ?? memoryCount).slice(0, 60)}`,
        content: String(memory.content ?? memory.text ?? JSON.stringify(memory)).slice(0, 20_000),
        evidence: [`imported-from-prime:${name}`],
        confidence: Math.min(1, Math.max(0, Number(memory.confidence ?? 0.5))),
        ttl_days: 30,
        status: 'proposed',
        created_at: Date.now(),
        provenance: 'prime-import',
      };
      if (!dryRun) {
        fs.mkdirSync(refineRoot, { recursive: true });
        fs.writeFileSync(path.join(refineRoot, `${id}.json`), JSON.stringify(layer, null, 2), 'utf8');
      }
    }
    report.imported.push({ what: `memories (${name})`, count: memoryCount, destination: 'refinement layers kind=global-memory status=proposed (operator approval required)' });
    break;
  }
  if (memoryCount === 0) report.unsupported.push({ what: 'memories', reason: 'no memories file recognized (looked for memories.jsonl|memories.json|memory.jsonl)' });
  report.counts.memories = memoryCount;

  // ── skills → ~/.dsh/skills/<name>/ ────────────────────────────────────────
  const skillsDir = path.join(source, 'skills');
  let skillCount = 0;
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir)) {
      const from = path.join(skillsDir, String(entry));
      if (!fs.statSync(from).isDirectory()) continue;
      skillCount += 1;
      if (!dryRun) {
        const destSkill = path.join(HOME, 'skills', String(entry));
        fs.mkdirSync(destSkill, { recursive: true });
        fs.cpSync(from, destSkill, { recursive: true });
      }
    }
    report.imported.push({ what: 'skills', count: skillCount, destination: '~/.dsh/skills/<name>/' });
  } else {
    report.unsupported.push({ what: 'skills/', reason: 'no skills directory found' });
  }
  report.counts.skills = skillCount;

  // ── prompt notes → active session-note layers ────────────────────────────
  const noteCandidates = ['prompt-notes.jsonl', 'notes.jsonl'];
  let noteCount = 0;
  for (const name of noteCandidates) {
    const file = path.join(source, name);
    if (!fs.existsSync(file)) continue;
    for (const note of readJsonl(file)) {
      noteCount += 1;
      const id = `imp_note_${String(noteCount).padStart(4, '0')}`;
      const layer = {
        id,
        session: '',
        kind: 'session-note',
        target: 'system-prompt',
        content: String(note.content ?? note.text ?? JSON.stringify(note)).slice(0, 20_000),
        evidence: [`imported-from-prime:${name}`],
        confidence: 0.9,
        ttl_days: 90,
        status: 'active',
        created_at: Date.now(),
        provenance: 'prime-import',
      };
      if (!dryRun) {
        fs.mkdirSync(refineRoot, { recursive: true });
        fs.writeFileSync(path.join(refineRoot, `${id}.json`), JSON.stringify(layer, null, 2), 'utf8');
      }
    }
    report.imported.push({ what: `prompt notes (${name})`, count: noteCount, destination: 'refinement layers kind=session-note status=active' });
    break;
  }
  if (noteCount === 0) report.unsupported.push({ what: 'prompt notes', reason: 'no notes file recognized (looked for prompt-notes.jsonl|notes.jsonl)' });
  report.counts.promptNotes = noteCount;

  // ── sub-agent specs: reported, not generated ─────────────────────────────
  const subagentsFile = path.join(source, 'subagents.json');
  if (fs.existsSync(subagentsFile)) {
    try {
      const specs = JSON.parse(fs.readFileSync(subagentsFile, 'utf8'));
      const list = Array.isArray(specs) ? specs : Object.keys(specs ?? {});
      report.unsupported.push({
        what: `sub-agent specs (${list.length})`,
        reason: 'dsh agent presets are Cordis compositions; spec→preset generation is Phase-6 work. Specs archived at storages/prime/imported/subagents.json.',
      });
      if (!dryRun) {
        fs.mkdirSync(importDir, { recursive: true });
        fs.copyFileSync(subagentsFile, path.join(importDir, 'subagents.json'));
      }
    } catch (error) {
      report.unsupported.push({ what: 'subagents.json', reason: `unparsable: ${error.message}` });
    }
  } else {
    report.unsupported.push({ what: 'sub-agent specs', reason: 'no subagents.json found' });
  }

  // ── refinement history: audit-only ───────────────────────────────────────
  const historyFile = path.join(source, 'refinement-history.jsonl');
  if (fs.existsSync(historyFile)) {
    const records = readJsonl(historyFile);
    if (!dryRun) {
      fs.mkdirSync(importDir, { recursive: true });
      fs.copyFileSync(historyFile, path.join(importDir, 'refinement-history.jsonl'));
    }
    report.imported.push({ what: 'refinement history', count: records.length, destination: 'archived audit copy (NOT re-applied, per plan §4.9)' });
  } else {
    report.unsupported.push({ what: 'refinement history', reason: 'no refinement-history.jsonl found' });
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const total = report.imported.reduce((acc, r) => acc + r.count, 0);
  process.stdout.write(`\nreport completeness: ${report.imported.length + report.unsupported.length} categories accounted for; ${total} item(s) ${dryRun ? 'would be ' : ''}imported\n`);
}

main();
