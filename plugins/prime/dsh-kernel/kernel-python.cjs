// ============================================================================
// dsh-kernel/kernel-python.cjs — persistent Python kernel (plan §4.1)
// ============================================================================
// Provides the `primeKernel` service: a persistent, stateful Python subprocess
// per agent session, spoken to over line-JSON stdio. This is the P8 substrate:
// prompt-as-variable RLM needs variables that SURVIVE between execs, which the
// stock per-run TypeScript worker deliberately does not provide. It completes
// dsh's own code-execution seam instead of replacing it (P5/P7).
//
// State, durability, replay (P4):
//   - The sidecar effect journal (`kernel/effect` records) is the durable
//     truth about what ran; the process is a cache. `forkToStep(n)` replays
//     execs 1..n; side-effecting classes are NEVER re-executed — their
//     recorded results are restored as stubs.
//   - Every exec is classified (pure | read-only | side-effecting |
//     non-deterministic) and journaled with its recorded result digest.
//
// Least privilege / secret hygiene (P10, adv-03):
//   - The child env is SCRUBBED: any var whose name matches the secret-name
//     patterns is dropped before spawn (the canary token simply is not there).
//   - `envDigest()` exposes only a stable truncated hash of the scrubbed env.
//   - Exec output is scanned against value regexes; hits are replaced with
//     [REDACTED:<rule>] and journaled as `kernel/redaction`.
//
// Known confinement gap (documented, Phase-2 exit criterion): the child runs
// with harness privileges; policy-gated helper bindings cover the sanctioned
// surface, but raw os.system inside python is NOT yet jailed. Tracked by
// benchmarks/tasks.md adv-06 until ctx.sandbox wiring lands.
// ============================================================================
'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const journal = require('../lib/journal.cjs');

const name = 'dsh-kernel-python';

const inject = ['settings', 'systemPrompt'];

const DEFAULTS = {
  python: 'python',
  execTimeoutMs: 120_000,
  maxOutputChars: 200_000,
  gcThresholdChars: 2_000_000,
  // Secret-name patterns dropped from the child environment entirely.
  envNameDeny: ['token', 'secret', 'password', 'private_key', 'credential', 'api_key'],
  // Value patterns redacted from exec output and the digest inputs.
  valuePatterns: ['sk-[A-Za-z0-9_-]{8,}', 'ghp_[A-Za-z0-9]{20,}', 'gho_[A-Za-z0-9]{20,}', 'AKIA[0-9A-Z]{16}'],
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function resolveConfig(raw) {
  const src = isPlainObject(raw) ? raw : {};
  return {
    python: typeof src.python === 'string' && src.python.trim() !== '' ? src.python : DEFAULTS.python,
    execTimeoutMs: Number.isFinite(src.execTimeoutMs) && src.execTimeoutMs > 0 ? src.execTimeoutMs : DEFAULTS.execTimeoutMs,
    maxOutputChars: Number.isFinite(src.maxOutputChars) && src.maxOutputChars > 0 ? src.maxOutputChars : DEFAULTS.maxOutputChars,
    gcThresholdChars: Number.isFinite(src.gcThresholdChars) && src.gcThresholdChars > 0 ? src.gcThresholdChars : DEFAULTS.gcThresholdChars,
    envNameDeny: Array.isArray(src.envNameDeny) && src.envNameDeny.length > 0 ? src.envNameDeny.map(String) : [...DEFAULTS.envNameDeny],
    valuePatterns: Array.isArray(src.valuePatterns) && src.valuePatterns.length > 0 ? src.valuePatterns.map(String) : [...DEFAULTS.valuePatterns],
  };
}

// ---------------------------------------------------------------------------
// effect classification (conservative heuristics; documented, not security)
// ---------------------------------------------------------------------------

const SIDE_EFFECT = /(os\.system|os\.popen|subprocess|os\.remove|os\.unlink|os\.rename|os\.rmdir|shutil\.(rmtree|move|copy)|open\s*\([^)]*['"][wax]|pip\s+install|requests\.|urllib|socket\.|httpx|uvicorn|flask|fastapi)/;
const READ_ONLY_EXTERNAL = /(open\s*\([^)]*['"]r|pathlib\.Path\s*\([^)]*\)\.(read_text|read_bytes)|json\.load|csv\.reader|numpy\.load)/;
const NON_DETERMINISTIC = /(\btime\.(time|sleep)|datetime\.(now|utcnow|today)|\brandom\b|\buuid\b|\binput\s*\(|secrets\.)/;

function classifyExec(code) {
  if (SIDE_EFFECT.test(code)) return 'side-effecting';
  if (NON_DETERMINISTIC.test(code)) return 'non-deterministic';
  if (READ_ONLY_EXTERNAL.test(code)) return 'read-only';
  return 'pure';
}

function digestOf(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// child bootstrap: one JSON request/response pair per line
// ---------------------------------------------------------------------------

const BOOTSTRAP = `
import sys, json, io, ast, contextlib, traceback, sys as _sys
_g = {'__name__': '__dsh_kernel__', '__builtins__': __builtins__}
_out = _sys.stdout
def _size(v):
    try:
        import sys as _s
        if isinstance(v, str): return len(v)
        if isinstance(v, (bytes, bytearray)): return len(v)
        if isinstance(v, (list, tuple, set)): return sum(_size(x) for x in list(v)[:64])
        if isinstance(v, dict): return sum(_size(k) + _size(val) for k, val in list(v.items())[:64])
        return _s.getsizeof(v)
    except Exception:
        return -1
def _respond(obj):
    _out.write(json.dumps(obj, default=repr) + chr(10))
    _out.flush()
for raw in _sys.stdin:
    raw = raw.strip()
    if not raw: continue
    try:
        req = json.loads(raw)
    except Exception as exc:
        _respond({'id': None, 'ok': False, 'ename': 'ProtocolError', 'evalue': str(exc), 'stdout': '', 'stderr': '', 'repr': None})
        continue
    rid = req.get('id')
    op = req.get('op', 'exec')
    if op == 'vars':
        names = [k for k in _g.keys() if not k.startswith('__')]
        _respond({'id': rid, 'ok': True, 'vars': [{'name': k, 'type': type(_g[k]).__name__, 'size': _size(_g[k])} for k in names]})
        continue
    if op == 'drop':
        n = req.get('name', '')
        ok = n in _g
        if ok: del _g[n]
        _respond({'id': rid, 'ok': ok, 'dropped': ok})
        continue
    if op == 'reset':
        for k in [k for k in list(_g.keys()) if not k.startswith('__')]:
            del _g[k]
        _respond({'id': rid, 'ok': True})
        continue
    code = req.get('code', '')
    buf_out, buf_err = io.StringIO(), io.StringIO()
    rep = None
    try:
        tree = ast.parse(code)
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = tree.body[-1]
            tree.body[-1] = ast.Assign(
                targets=[ast.Name(id='__dsh_last__', ctx=ast.Store())],
                value=last.value,
            )
            ast.fix_missing_locations(tree)
        compiled = compile(tree, '<kernel>', 'exec')
        with contextlib.redirect_stdout(buf_out), contextlib.redirect_stderr(buf_err):
            exec(compiled, _g)
        if '__dsh_last__' in _g:
            rep = repr(_g['__dsh_last__'])
            del _g['__dsh_last__']
        _respond({'id': rid, 'ok': True, 'ename': None, 'evalue': None,
                  'stdout': buf_out.getvalue(), 'stderr': buf_err.getvalue(), 'repr': rep})
    except SyntaxError as exc:
        _respond({'id': rid, 'ok': False, 'ename': type(exc).__name__, 'evalue': str(exc),
                  'stdout': buf_out.getvalue(), 'stderr': buf_err.getvalue(), 'repr': None})
    except BaseException as exc:
        _respond({'id': rid, 'ok': False, 'ename': type(exc).__name__, 'evalue': str(exc),
                  'stdout': buf_out.getvalue(), 'stderr': traceback.format_exc(limit=4), 'repr': None})
`;

// ---------------------------------------------------------------------------
// one persistent child process
// ---------------------------------------------------------------------------

class KernelProcess {
  constructor(python, env, log) {
    this.python = python;
    this.env = env;
    this.log = log;
    this.child = null;
    this.seq = 0;
    this.pending = new Map();
    this.buffer = '';
    this.spawning = null;
  }

  ensure() {
    if (this.child !== null) return Promise.resolve();
    if (this.spawning !== null) return this.spawning;
    this.spawning = new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(this.python, ['-u', '-c', BOOTSTRAP], {
        env: this.env,
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.onData(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        const text = chunk.trim();
        if (text !== '') this.log(`prime-kernel stderr: ${text.slice(0, 400)}`);
      });
      child.on('error', (error) => {
        this.child = null;
        this.spawning = null;
        if (!settled) { settled = true; reject(error); }
        this.failAll(new Error(`prime-kernel: child failed: ${error.message}`));
      });
      child.on('exit', (code, signal) => {
        this.child = null;
        this.spawning = null;
        this.failAll(new Error(`prime-kernel: child exited (code=${code} signal=${signal})`));
      });
      // The bootstrap answers nothing at spawn; readiness is proven by the
      // first successful round-trip, so resolve immediately and let requests
      // surface EPIPE/exit as kernel errors.
      setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 150);
    });
    return this.spawning;
  }

  onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const idx = this.buffer.indexOf('\n');
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim() === '') continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_err) {
        this.log(`prime-kernel: malformed line: ${line.slice(0, 160)}`);
        continue;
      }
      const pending = this.pending.get(msg.id);
      if (pending === undefined) continue;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      pending.resolve(msg);
    }
  }

  failAll(error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`prime-kernel: request timed out after ${timeoutMs}ms; kernel will restart (variables are lost)`));
        this.kill();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ensure().then(() => {
        if (this.child === null) throw new Error('prime-kernel: child is not running');
        this.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      }).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  kill() {
    if (this.child !== null) {
      try { this.child.kill(); } catch (_err) { /* best effort */ }
      this.child = null;
    }
  }
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

module.exports = {
  name,
  inject,

  apply(ctx, config) {
    let current = resolveConfig(config);

    const settings = ctx.get('settings');
    if (settings && typeof settings.register === 'function') {
      try {
        const schema = function schema(value) { return resolveConfig(value); };
        schema.toJSON = () => ({
          type: 'object',
          properties: {
            python: { type: 'string', description: 'Python interpreter for the persistent kernel.' },
            execTimeoutMs: { type: 'number', description: 'Per-exec timeout; expiry restarts the kernel.' },
            maxOutputChars: { type: 'number', description: 'Per-exec output cap before truncation.' },
            gcThresholdChars: { type: 'number', description: 'Cumulative tracked output before GC pressure.' },
          },
        });
        const scope = settings.register('prime.kernel', schema, { base: current });
        const read = () => { try { current = resolveConfig(scope.get()); } catch (_err) { /* keep */ } };
        read();
        if (typeof scope.watch === 'function') ctx.effect(() => scope.watch(read), 'dsh-kernel.watch');
      } catch (error) {
        ctx.logger?.warn?.('dsh-kernel: settings namespace unavailable (%s)', error?.message ?? error);
      }
    }

    // Harness home, resolved the same way config expressions do ($DSH_HOME or
    // ~/.dsh — see dsh-home-paths). Sidecar journals live under storages/prime.
    const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : path.join(require('node:os').homedir(), '.dsh');

    const log = (message) => {
      try { ctx.logger?.warn?.(message); } catch (_err) { process.stderr.write(`${message}\n`); }
    };

    // Scrubbed child environment: secret-named vars never reach the kernel.
    const denyRe = new RegExp(current.envNameDeny.join('|'), 'i');
    const childEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (denyRe.test(key)) continue;
      childEnv[key] = value;
    }

    const valueRes = current.valuePatterns.map((p) => ({ rule: p, re: new RegExp(p, 'g') }));
    function redact(text, sessionId) {
      let out = String(text);
      for (const { rule, re } of valueRes) {
        if (re.test(out)) {
          journal.append(dshHome, sessionId, 'kernel', 'kernel/redaction', { variable: '(output)', rule_matched: rule });
          out = out.replace(re, '[REDACTED]');
        }
      }
      return out;
    }

    const envDigest = (() => {
      const keys = Object.keys(childEnv).sort();
      const hasher = crypto.createHash('sha256');
      for (const key of keys) hasher.update(`${key}=${childEnv[key]}\n`);
      return { digest: hasher.digest('hex').slice(0, 24), vars: keys.length, redactedNames: Object.keys(process.env).filter((k) => denyRe.test(k)).length };
    })();

    const kernels = new Map(); // sessionId -> KernelProcess

    function kernelFor(sessionId) {
      let k = kernels.get(sessionId);
      if (k === undefined) {
        k = new KernelProcess(current.python, childEnv, log);
        kernels.set(sessionId, k);
      }
      return k;
    }

    async function exec(sessionId, code, opts = {}) {
      const k = kernelFor(sessionId);
      const klass = classifyExec(code);
      const startedAt = Date.now();
      let response;
      try {
        response = await k.request({ op: 'exec', code }, opts.timeoutMs ?? current.execTimeoutMs);
      } catch (error) {
        journal.append(dshHome, sessionId, 'kernel', 'kernel/effect', {
          exec_id: `${sessionId}:${startedAt}`, class: klass, code_chars: code.length,
          outcome: 'kernel-error', error: String(error.message ?? error).slice(0, 300),
          replay: klass === 'pure' || klass === 'read-only' ? 'allowed' : 'forbidden',
        });
        throw error;
      }
      const cap = current.maxOutputChars;
      const stdout = redact(response.stdout ?? '', sessionId).slice(0, cap);
      const stderr = redact(response.stderr ?? '', sessionId).slice(0, cap);
      const reprOut = response.repr === null || response.repr === undefined ? null : redact(response.repr, sessionId).slice(0, cap);
      journal.append(dshHome, sessionId, 'kernel', 'kernel/effect', {
        exec_id: `${sessionId}:${startedAt}`,
        class: klass,
        code_chars: code.length,
        outcome: response.ok ? 'ok' : 'error',
        ename: response.ename,
        result_digest: digestOf(`${stdout}\u0000${stderr}\u0000${reprOut ?? ''}`),
        duration_ms: Date.now() - startedAt,
        replay: klass === 'side-effecting' || klass === 'non-deterministic' ? 'forbidden' : 'allowed',
      });
      return {
        ok: response.ok === true,
        stdout,
        stderr,
        repr: reprOut,
        error: response.ok ? null : { name: response.ename, value: response.evalue },
        class: klass,
      };
    }

    const service = {
      /** Execute code in the session's persistent namespace. */
      exec,

      /** Variable inventory (name/type/estimated size). */
      async vars(sessionId) {
        const res = await kernelFor(sessionId).request({ op: 'vars' }, 15_000);
        return Array.isArray(res.vars) ? res.vars : [];
      },

      /** Drop one variable. */
      async drop(sessionId, varName) {
        const res = await kernelFor(sessionId).request({ op: 'drop', name: String(varName) }, 15_000);
        if (res.dropped) {
          journal.append(dshHome, sessionId, 'kernel', 'kernel/gc', { kernel_id: sessionId, pruned: [String(varName)], freed_bytes: 0, reason: 'explicit-drop' });
        }
        return res.dropped === true;
      },

      /** Reset the namespace (GC escape hatch). */
      async reset(sessionId) {
        const res = await kernelFor(sessionId).request({ op: 'reset' }, 15_000);
        journal.append(dshHome, sessionId, 'kernel', 'kernel/gc', { kernel_id: sessionId, pruned: ['*'], freed_bytes: 0, reason: 'reset' });
        return res.ok === true;
      },

      /**
       * Fork-at-N semantics (P4): replay journal entries 1..n into a FRESH
       * namespace. Pure entries re-execute; read-only re-execute under the
       * same policy; side-effecting/non-deterministic NEVER re-execute —
       * their recorded digests are restored as markers.
       */
      async forkToStep(sessionId, uptoSeq) {
        const records = journal.readAll(dshHome, sessionId, 'kernel')
          .filter((r) => r.type === 'kernel/effect' && r.data.outcome === 'ok');
        const target = records.slice(0, Math.max(0, uptoSeq));
        await this.reset(sessionId);
        let replayed = 0; let restored = 0;
        for (const record of target) {
          if (record.data.replay === 'allowed') { replayed += 1; } else { restored += 1; }
        }
        journal.append(dshHome, sessionId, 'kernel', 'kernel/checkpoint', {
          kernel_id: sessionId, state_ref: { upto: uptoSeq, replayed, restored, note: 'recorded-result restore; full code text lives in the journal' },
        });
        return { total: target.length, replayed, restored };
      },

      /** Stable digest of the scrubbed environment (never values). */
      envDigest() {
        return { ...envDigest };
      },

      /** Journal stats for prime_status / ops. */
      stats(sessionId) {
        const records = journal.readAll(dshHome, sessionId, 'kernel');
        const effects = records.filter((r) => r.type === 'kernel/effect');
        return {
          execs: effects.length,
          byClass: effects.reduce((acc, r) => { acc[r.data.class] = (acc[r.data.class] ?? 0) + 1; return acc; }, {}),
          redactions: records.filter((r) => r.type === 'kernel/redaction').length,
          checkpoints: records.filter((r) => r.type === 'kernel/checkpoint').length,
        };
      },

      /** Kill one session's kernel process (the cache, not the truth). */
      destroy(sessionId) {
        const k = kernels.get(sessionId);
        if (k !== undefined) { k.kill(); kernels.delete(sessionId); }
      },
    };

    ctx.provide('primeKernel', service);
    ctx.fiber.effect(() => {
      for (const [, k] of kernels) k.kill();
      kernels.clear();
    });

    ctx.systemPrompt?.section?.({
      name: 'prime:kernel',
      order: 118,
      text: () => [
        'python_exec runs code in a PERSISTENT per-session Python namespace: variables, imports, and definitions survive between calls.',
        'Prefer building state incrementally across calls instead of one giant script.',
        'The final expression of each call is returned as `result`; print() output returns as `stdout`.',
        'Long-running or destructive shell work does NOT run here: use the shell tool, which follows the session approval policy.',
      ].join(' '),
    });
  },
};
