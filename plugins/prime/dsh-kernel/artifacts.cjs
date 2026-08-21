// ============================================================================
// dsh-kernel/artifacts.cjs — hash-addressed artifact store (plan §4.1)
// ============================================================================
// Large immutable outputs (build logs, datasets, screenshots) live OUT of
// prompt context under storages/prime/artifacts/<sha256>, referenceable from
// journals and tools by id. Boundary rule (§4.1): working state belongs to
// kernel vars; large immutable outputs belong here.
// ============================================================================
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const name = 'dsh-kernel-artifacts';

const inject = [];

module.exports = {
  name,
  inject,

  apply(ctx, config) {
    const maxBytes = Number.isFinite(config?.maxBytes) && config.maxBytes > 0 ? config.maxBytes : 64 * 1024 * 1024;
    const root = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
      ? path.join(process.env.DSH_HOME, 'storages', 'prime', 'artifacts')
      : path.join(os.homedir(), '.dsh', 'storages', 'prime', 'artifacts');
    fs.mkdirSync(root, { recursive: true });

    const fileOf = (id) => path.join(root, id);

    const artifacts = {
      /** Store bytes/text; returns { id, size, path }. Idempotent by content. */
      put(sessionId, suggestedName, content, meta) {
        const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
        if (buffer.length > maxBytes) throw new Error(`artifact exceeds maxBytes (${buffer.length} > ${maxBytes})`);
        const id = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
        const file = fileOf(id);
        if (!fs.existsSync(file)) fs.writeFileSync(file, buffer);
        const record = {
          id,
          name: String(suggestedName ?? 'artifact.bin').slice(0, 120),
          size: buffer.length,
          session: String(sessionId ?? ''),
          created_at: Date.now(),
          meta: meta && typeof meta === 'object' ? meta : {},
        };
        fs.writeFileSync(`${file}.json`, JSON.stringify(record, null, 2), 'utf8');
        return record;
      },

      /** Read one artifact as Buffer, or null when unknown. */
      get(id) {
        const file = fileOf(String(id));
        if (!fs.existsSync(file)) return null;
        return fs.readFileSync(file);
      },

      /** Metadata for one artifact, or null. */
      describe(id) {
        const file = `${fileOf(String(id))}.json`;
        if (!fs.existsSync(file)) return null;
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_err) { return null; }
      },

      /** Newest-first metadata list, optionally filtered by session. */
      list(sessionId, limit = 50) {
        const out = [];
        for (const entry of fs.readdirSync(root)) {
          if (!entry.endsWith('.json')) continue;
          try {
            const record = JSON.parse(fs.readFileSync(path.join(root, entry), 'utf8'));
            if (sessionId === undefined || record.session === String(sessionId)) out.push(record);
          } catch (_err) { /* skip corrupt sidecar */ }
        }
        out.sort((a, b) => b.created_at - a.created_at);
        return out.slice(0, limit);
      },
    };

    ctx.provide('artifacts', artifacts);
  },
};
