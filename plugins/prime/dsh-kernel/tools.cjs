// ============================================================================
// dsh-kernel/tools.cjs — the kernel's model-facing consumer seam (P5)
// ============================================================================
// "A kernel without a model-facing consumer tool is not a seam." These are the
// three-role consumers:
//
//   python_exec      the RLM preset's primary capability: persistent REPL.
//   history_search   kernel retrieval helpers so the model can PULL context
//   turns_last       on demand instead of the harness pushing everything into
//                    the envelope (plan §4.2 envelope quality control).
//   vars_describe    inventory of persistent kernel state.
//   artifact_put /
//   artifacts_get    hash-addressed large outputs, out of prompt context.
//
// Definitions are plain ToolDefinition objects (the loader imports this file
// directly; defineTool is an ESM-only convenience that projects to exactly
// this shape).
// ============================================================================
'use strict';

const name = 'dsh-kernel-tools';

const inject = ['tools', 'primeKernel', 'artifacts'];

function textBlock(text) {
  return [{ type: 'text', text }];
}

function objSchema(properties, required) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function strProp(description) {
  return { type: 'string', description };
}

module.exports = {
  name,
  inject,

  apply(ctx) {
    const kernel = ctx.primeKernel;
    const artifacts = ctx.artifacts;

    ctx.tools.register({
      name: 'python_exec',
      description: [
        'Run Python code in a PERSISTENT per-session namespace: variables, imports, and definitions survive between calls.',
        'The last expression is returned as `result`; print() output as `stdout`.',
        'Build state incrementally across calls. Use for computation, transformation, analysis, and orchestrating the other tools programmatically.',
        'Destructive shell work belongs to the shell tool, which follows the session approval policy.',
      ].join(' '),
      parameters: objSchema({ code: strProp('Python source. The final expression becomes `result`.') }, ['code']),
      output: {
        schema: objSchema({
          ok: { type: 'boolean' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          result: { type: 'string', description: 'repr of the last expression; empty string when the call had none.' },
          error: {
            type: 'object',
            properties: { name: { type: 'string' }, value: { type: 'string' } },
            required: ['name', 'value'],
            additionalProperties: false,
            description: 'Empty name/value strings when the call succeeded.',
          },
          effect_class: { type: 'string' },
        }, ['ok', 'stdout', 'stderr', 'result', 'error', 'effect_class']),
        render(_args, value) {
          const parts = [];
          if (value.stdout !== '') parts.push(value.stdout);
          if (value.stderr !== '') parts.push(`stderr:\n${value.stderr}`);
          if (value.result !== '') parts.push(`result: ${value.result}`);
          if (value.error.name !== '') parts.push(`${value.error.name}: ${value.error.value}`);
          return textBlock(parts.join('\n') || '(no output)');
        },
      },
      timeoutMs: 180_000,
      async execute(args, exec) {
        const sessionId = exec.agent?.id ?? 'unowned';
        const outcome = await kernel.exec(sessionId, String(args.code ?? ''));
        return {
          ok: outcome.ok,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          result: outcome.repr ?? '',
          error: outcome.ok ? { name: '', value: '' } : { name: String(outcome.error.name), value: String(outcome.error.value).slice(0, 2000) },
          effect_class: outcome.class,
        };
      },
      presentCall: (args) => ({ card: 'generic', title: 'python_exec', kind: 'other', rawInput: String(args.code ?? '').slice(0, 500) }),
    });

    ctx.tools.register({
      name: 'history_search',
      description: 'Search this session\'s full event log (user messages, assistant messages, tool results) for a query string. Use this to pull specific earlier context on demand instead of re-reading everything.',
      parameters: objSchema({
        query: strProp('Case-insensitive substring to search for.'),
        limit: { type: 'number', description: 'Maximum matches to return (default 8).' },
      }, ['query']),
      output: {
        schema: objSchema({ matches: { type: 'array', items: { type: 'object', properties: { seq: { type: 'number' }, type: { type: 'string' }, snippet: { type: 'string' } }, required: ['seq', 'type', 'snippet'], additionalProperties: false } } }, ['matches']),
        render(_args, value) {
          if (value.matches.length === 0) return textBlock('(no matches)');
          return textBlock(value.matches.map((m) => `#${m.seq} [${m.type}] ${m.snippet}`).join('\n'));
        },
      },
      async execute(args, exec) {
        const events = exec.agent?.session?.events ?? [];
        const needle = String(args.query ?? '').toLowerCase();
        const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.min(args.limit, 50) : 8;
        const matches = [];
        if (needle !== '') {
          for (const event of events) {
            let text = '';
            try { text = JSON.stringify(event.data); } catch (_err) { continue; }
            const idx = text.toLowerCase().indexOf(needle);
            if (idx < 0) continue;
            matches.push({ seq: event.seq, type: event.type, snippet: text.slice(Math.max(0, idx - 60), idx + needle.length + 120) });
            if (matches.length >= limit) break;
          }
        }
        return { matches };
      },
      presentCall: (args) => ({ card: 'generic', title: 'history_search', kind: 'read', rawInput: String(args.query ?? '') }),
    });

    ctx.tools.register({
      name: 'turns_last',
      description: 'Summarize the last N turns of this session from the event log: one line per user message, assistant message, and tool call.',
      parameters: objSchema({ n: { type: 'number', description: 'How many recent turns (default 3, max 20).' } }, []),
      output: {
        schema: objSchema({ lines: { type: 'array', items: { type: 'string' } } }, ['lines']),
        render(_args, value) { return textBlock(value.lines.join('\n') || '(empty)'); },
      },
      async execute(args, exec) {
        const events = exec.agent?.session?.events ?? [];
        const n = Number.isFinite(args.n) && args.n > 0 ? Math.min(args.n, 20) : 3;
        const turns = [...new Set(events.filter((e) => e.type === 'turn/start').map((e) => e.data.turn))].slice(-n);
        const set = new Set(turns);
        const lines = [];
        for (const event of events) {
          const turn = event.data?.turn;
          if (typeof turn !== 'number' || !set.has(turn)) continue;
          if (event.type === 'user/message') {
            const text = (event.data.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
            lines.push(`t${turn} user: ${text.slice(0, 160)}`);
          } else if (event.type === 'assistant/message') {
            const text = (event.data.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
            lines.push(`t${turn} assistant: ${text.slice(0, 160)}`);
          } else if (event.type === 'tool/call') {
            lines.push(`t${turn} tool: ${event.data.name}(${String(event.data.arguments).slice(0, 80)})`);
          }
        }
        return { lines };
      },
      presentCall: () => ({ card: 'generic', title: 'turns_last', kind: 'read' }),
    });

    ctx.tools.register({
      name: 'vars_describe',
      description: 'List the variables currently defined in the persistent Python kernel namespace, with types and approximate sizes. Pass a name to drop it.',
      parameters: objSchema({
        drop: strProp('Optional variable name to delete from the namespace.'),
      }, []),
      output: {
        schema: objSchema({
          vars: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, size: { type: 'number' } }, required: ['name', 'type', 'size'], additionalProperties: false } },
          dropped: { type: 'boolean' },
        }, ['vars', 'dropped']),
        render(_args, value) {
          const rows = value.vars.map((v) => `${v.name}: ${v.type} (~${v.size}B)`);
          if (value.dropped) rows.push('(dropped requested variable)');
          return textBlock(rows.join('\n') || '(namespace is empty)');
        },
      },
      async execute(args, exec) {
        const sessionId = exec.agent?.id ?? 'unowned';
        let dropped = false;
        if (typeof args.drop === 'string' && args.drop !== '') dropped = await kernel.drop(sessionId, args.drop);
        return { vars: await kernel.vars(sessionId), dropped };
      },
      presentCall: () => ({ card: 'generic', title: 'kernel variables', kind: 'read' }),
    });

    ctx.tools.register({
      name: 'artifact_put',
      description: 'Store large immutable output (a build log, dataset slice, report) outside the conversation as a content-addressed artifact. Returns its id; reference the id instead of pasting large text into the chat.',
      parameters: objSchema({
        name: strProp('Short human-readable name.'),
        text: strProp('The artifact content (UTF-8 text).'),
      }, ['name', 'text']),
      output: {
        schema: objSchema({ id: { type: 'string' }, size: { type: 'number' }, name: { type: 'string' } }, ['id', 'size', 'name']),
        render(_args, value) { return textBlock(`artifact ${value.id} (${value.size} bytes) saved as "${value.name}"`); },
      },
      async execute(args, exec) {
        const sessionId = exec.agent?.id ?? 'unowned';
        const record = artifacts.put(sessionId, args.name, String(args.text ?? ''), {});
        return { id: record.id, size: record.size, name: record.name };
      },
      presentCall: (args) => ({ card: 'generic', title: 'artifact_put', kind: 'other', rawInput: String(args.name ?? '') }),
    });

    ctx.tools.register({
      name: 'artifacts_get',
      description: 'Read one stored artifact by id (as returned by artifact_put).',
      parameters: objSchema({ id: strProp('Artifact id.') }, ['id']),
      output: {
        schema: objSchema({ found: { type: 'boolean' }, name: { type: 'string' }, size: { type: 'number' }, text: { type: 'string' } }, ['found', 'name', 'size', 'text']),
        render(_args, value) {
          if (!value.found) return textBlock('(unknown artifact id)');
          return textBlock(`"${value.name}" (${value.size} bytes):\n${value.text.slice(0, 4000)}`);
        },
      },
      async execute(args, exec) {
        const buffer = artifacts.get(String(args.id ?? ''));
        if (buffer === null) return { found: false, name: '', size: 0, text: '' };
        const meta = artifacts.describe(String(args.id ?? ''));
        return { found: true, name: meta?.name ?? '', size: buffer.length, text: buffer.toString('utf8') };
      },
      presentCall: (args) => ({ card: 'generic', title: 'artifacts_get', kind: 'read', rawInput: String(args.id ?? '') }),
    });
  },
};
