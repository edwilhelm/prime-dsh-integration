// ============================================================================
// lib/journal.cjs — append-only sidecar journals (P4 adaptation)
// ============================================================================
// The persistence coordinator refuses session logs containing event types
// unknown to the build unless the envelope carries `ignorable: true`, and
// Session.append() cannot set that marker. Until upstream lands a plugin
// event-registration surface (plan §12), every new durable record written by
// the prime plugins is an append-only JSONL sidecar under
//   <dshHome>/storages/prime/<sessionId>/<family>.jsonl
// with the same envelope discipline as the session log: { type, seq, time,
// data } and monotonic per-family seq. prime-ops verify reconstructs and
// checks these against the session log.
// ============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function primeRoot(dshHome) {
  return path.join(dshHome, 'storages', 'prime');
}

function sessionDir(dshHome, sessionId) {
  const dir = path.join(primeRoot(dshHome), String(sessionId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Append one record; returns the assigned seq. Synchronous, fsync-best-effort. */
function append(dshHome, sessionId, family, type, data) {
  const file = path.join(sessionDir(dshHome, sessionId), `${family}.jsonl`);
  let seq = 0;
  if (fs.existsSync(file)) {
    const size = fs.statSync(file).size;
    if (size > 0) {
      // Seq = count of prior lines; O(n) tail read is fine at sidecar volumes.
      const text = fs.readFileSync(file, 'utf8');
      for (let i = 0; i < text.length; i += 1) {
        if (text[i] === '\n') seq += 1;
      }
    }
  }
  const record = { type, seq, time: Date.now(), data };
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return seq;
}

/** Read all records of one family, oldest first. Missing file → []. */
function readAll(dshHome, sessionId, family) {
  const file = path.join(sessionDir(dshHome, sessionId), `${family}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const out = [];
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch (_err) {
      out.push({ type: 'journal/corrupt-line', seq: -1, time: 0, data: { line: line.slice(0, 200) } });
    }
  }
  return out;
}

/** Read every family present for one session: { family: records[] }. */
function readSession(dshHome, sessionId) {
  const dir = path.join(primeRoot(dshHome), String(sessionId));
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir)) {
    if (entry.endsWith('.jsonl')) out[entry.slice(0, -6)] = readAll(dshHome, sessionId, entry.slice(0, -6));
  }
  return out;
}

module.exports = { primeRoot, sessionDir, append, readAll, readSession };
