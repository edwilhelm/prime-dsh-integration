// Standalone check: the real kernel-python.cjs must scrub secret-named env
// vars from the child process and expose only a truncated digest.
'use strict';
const path = require('node:path');

process.env.PRIME_CANARY_SECRET = 'super-secret-canary-value';
process.env.MY_API_TOKEN = 'tok-1234567890';
process.env.HARMLESS_VAR = 'visible';

const plugin = require(path.join('..', 'dsh-kernel', 'kernel-python.cjs'));

const provided = {};
const effects = [];
const fakeCtx = {
  get() { return undefined; },
  provide(name, value) { provided[name] = value; },
  effect(fn) { effects.push(fn); },
  logger: { warn() {} },
  systemPrompt: { section() {} },
  fiber: { effect(fn) { effects.push(fn); } },
};

plugin.apply(fakeCtx, {});
const kernel = provided.primeKernel;
if (kernel === undefined) throw new Error('primeKernel was not provided');

(async () => {
  const digest = kernel.envDigest();
  if (digest.redactedNames < 2) throw new Error(`expected >=2 scrubbed env names, got ${digest.redactedNames}`);
  console.log(`envDigest: ${digest.digest} over ${digest.vars} vars; scrubbed ${digest.redactedNames} secret-named vars`);

  // Exec inside the real child and inspect what IT sees.
  const out = await kernel.exec('selftest', [
    'import os, json, re',
    "pat = re.compile('token|secret|password|private_key|credential|api_key', re.I)",
    "print(json.dumps(sorted(k for k in os.environ if pat.search(k))))",
    "print(os.environ.get('PRIME_CANARY_SECRET', '<absent>'))",
  ].join('\n'));
  const seen = JSON.parse(out.stdout.split('\n')[0]);
  const canary = out.stdout.split('\n')[1];
  if (seen.length !== 0) throw new Error(`child still sees secret-named vars: ${seen.join(', ')}`);
  if (canary !== '<absent>') throw new Error(`CANARY LEAKED into kernel: ${canary}`);
  console.log('child env: no TOKEN/SECRET/PASSWORD/KEY/CREDENTIAL names visible; canary value absent');

  // Redaction of output values.
  const leak = await kernel.exec('selftest', 'print("token sk-abcdef1234567890 in output")');
  if (!leak.stdout.includes('[REDACTED]') || leak.stdout.includes('sk-abcdef1234567890')) {
    throw new Error(`value redaction failed: ${leak.stdout}`);
  }
  console.log('output redaction: sk-… pattern replaced with [REDACTED]');

  for (const fn of effects) { try { await fn(); } catch (_err) {} }
  console.log('KERNEL-SECURITY-CHECKS-OK');
})().catch((error) => { console.error(error.message); process.exit(1); });
