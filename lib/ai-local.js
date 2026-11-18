'use strict';
/**
 * Usage that other AI command-line tools leave on this computer. Nothing to
 * enter: the files are read where the tools write them.
 *
 * OpenAI Codex CLI: JSONL "rollout" files under ~/.codex/sessions. Token use is
 *   in token_count events (payload.info.total_token_usage, cumulative per session:
 *   input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens,
 *   total_tokens); the model is in turn_context lines and the folder in session_meta.
 * Gemini CLI: chat recordings under ~/.gemini/tmp/<project>/chats, JSONL (a
 *   metadata line, then one line per message; Gemini replies carry model and
 *   tokens: input, output, cached, thoughts, tool, total) or older JSON files with
 *   a messages array.
 * Field names come from each tool's source code. Files are re-read only when
 * they change.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function walk(dir, keep, depth = 6, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0) walk(p, keep, depth - 1, out);
    } else if (keep(p)) out.push(p);
  }
  return out;
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a half-written last line */
    }
  }
  return out;
}

/** One Codex rollout file -> { session, events[] }. Events are per-turn token deltas. */
function parseCodexFile(text, fallbackTs = Date.now()) {
  let model = 'unknown';
  let cwd = null;
  let id = null;
  let prev = null;
  const events = [];
  for (const obj of parseLines(text)) {
    const p = obj && typeof obj.payload === 'object' && obj.payload ? obj.payload : obj;
    const kind = p.type || obj.type;
    if (obj.type === 'session_meta' || kind === 'session_meta') {
      id = p.id || p.session_id || id;
      cwd = p.cwd || cwd;
    }
    if ((obj.type === 'turn_context' || kind === 'turn_context') && p.model) model = String(p.model);
    if (kind === 'token_count' && p.info && p.info.total_token_usage) {
      const t = p.info.total_token_usage;
      const cur = { input: n(t.input_tokens), cached: n(t.cached_input_tokens), output: n(t.output_tokens), reasoning: n(t.reasoning_output_tokens), total: n(t.total_tokens) };
      let d = prev ? { input: cur.input - prev.input, cached: cur.cached - prev.cached, output: cur.output - prev.output, reasoning: cur.reasoning - prev.reasoning, total: cur.total - prev.total } : cur;
      if (Object.values(d).some((v) => v < 0)) d = cur; // the count started again
      prev = cur;
      if (d.total > 0 || d.input + d.output > 0) {
        const ts = Date.parse(obj.timestamp || p.timestamp) || fallbackTs;
        events.push({ ts, model, input: d.input, cached: d.cached, output: d.output, reasoning: d.reasoning, total: d.total || d.input + d.output });
      }
    }
  }
  const title = cwd ? path.basename(String(cwd).replace(/[\\/]+$/, '')) : id ? `Session ${String(id).slice(0, 8)}` : 'Codex session';
  return { session: { title, id }, events };
}

/** One Gemini CLI chat recording (JSONL or older JSON) -> { session, events[] }. */
function parseGeminiFile(text, fallbackTs = Date.now()) {
  let meta = {};
  let messages = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && !trimmed.includes('\n{')) {
    try {
      const o = JSON.parse(trimmed);
      if (Array.isArray(o.messages)) {
        meta = o;
        messages = o.messages;
      } else meta = o;
    } catch {
      /* fall through to JSONL */
    }
  }
  if (!messages.length) {
    const lines = parseLines(text);
    const byId = new Map();
    lines.forEach((rec, i) => {
      if (i === 0 && rec.sessionId && !rec.type) meta = rec;
      else if (rec && typeof rec === 'object' && rec.type) byId.set(rec.id || `#${i}`, rec); // a later line for the same id replaces it
    });
    messages = [...byId.values()];
  }
  const events = [];
  for (const m of messages) {
    if (!m || m.type !== 'gemini' || !m.tokens) continue;
    const t = m.tokens;
    const input = n(t.input);
    const output = n(t.output);
    events.push({
      ts: Date.parse(m.timestamp) || fallbackTs,
      model: m.model ? String(m.model) : 'gemini',
      input,
      cached: n(t.cached),
      output,
      reasoning: n(t.thoughts),
      total: n(t.total) || input + output + n(t.thoughts) + n(t.tool),
    });
  }
  const title = meta.summary ? String(meta.summary).slice(0, 80) : meta.startTime ? `Session ${String(meta.startTime).slice(0, 10)}` : 'Gemini session';
  return { session: { title, id: meta.sessionId || null }, events };
}

class LocalTool {
  /** kind: 'codex' | 'gemini' */
  constructor(kind, root) {
    this.kind = kind;
    this.root = root || (kind === 'codex' ? path.join(os.homedir(), '.codex', 'sessions') : path.join(os.homedir(), '.gemini', 'tmp'));
    this.cache = new Map(); // file -> { mtimeMs, size, parsed }
  }

  get found() {
    return fs.existsSync(this.root);
  }

  files() {
    if (this.kind === 'codex') return walk(this.root, (p) => /rollout-.*\.jsonl$/i.test(path.basename(p)) || p.endsWith('.jsonl'));
    return walk(this.root, (p) => /[\\/]chats[\\/]/.test(p) && /\.(jsonl|json)$/i.test(p));
  }

  /** Every session with its token events (re-reading only files that changed). */
  scan() {
    const seen = new Set();
    const out = [];
    for (const file of this.files()) {
      seen.add(file);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const hit = this.cache.get(file);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        out.push(hit.parsed);
        continue;
      }
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const parsed = this.kind === 'codex' ? parseCodexFile(text, st.mtimeMs) : parseGeminiFile(text, st.mtimeMs);
      this.cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, parsed });
      out.push(parsed);
    }
    for (const f of this.cache.keys()) if (!seen.has(f)) this.cache.delete(f);
    return out;
  }
}

module.exports = { LocalTool, parseCodexFile, parseGeminiFile };
