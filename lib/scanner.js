'use strict';
/**
 * Reads Claude Code transcripts (~/.claude/projects/**\/*.jsonl) incrementally.
 *
 * Each file is read from the byte offset where the last scan stopped, so a live
 * session costs only its newly appended lines. Every API response is counted
 * once: Claude Code writes one transcript line per content block, all carrying
 * the same `usage`, so lines are deduplicated on `message.id` + `requestId`.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const SUBAGENT_DIR = `${path.sep}subagents${path.sep}`;

class TranscriptScanner {
  constructor(projectsDir) {
    this.projectsDir = projectsDir;
    this.files = new Map(); // file -> { offset, carry: Buffer }
    this.seen = new Map(); // message.id:requestId -> its record (later lines of the same response add tool calls)
    this.records = []; // one per API response, see handleAssistant()
    this.sessions = new Map(); // sessionId -> metadata
    this.stats = { files: 0, linesRead: 0, responses: 0, duplicateLines: 0, unreadableLines: 0, lastScanMs: 0 };
  }

  async listFiles(dir = this.projectsDir, out = []) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await this.listFiles(full, out);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
    return out;
  }

  /** Reads whatever was appended since the last scan. Resolves true when anything new was read. */
  async scan() {
    const started = Date.now();
    const files = await this.listFiles();
    let changed = false;
    for (const file of files) {
      let size;
      try {
        size = (await fsp.stat(file)).size;
      } catch {
        continue;
      }
      let state = this.files.get(file);
      if (!state) {
        state = { offset: 0, carry: Buffer.alloc(0) };
        this.files.set(file, state);
      }
      if (size < state.offset) {
        // Rewritten or truncated: read it again; already-counted responses are skipped by the dedupe set.
        state.offset = 0;
        state.carry = Buffer.alloc(0);
      }
      if (size === state.offset) continue;
      await this.readRange(file, state, size);
      changed = true;
    }
    this.stats.files = this.files.size;
    this.stats.lastScanMs = Date.now() - started;
    return changed;
  }

  readRange(file, state, end) {
    return new Promise((resolve) => {
      const stream = fs.createReadStream(file, { start: state.offset, end: end - 1 });
      let carry = state.carry;
      stream.on('data', (chunk) => {
        const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        let start = 0;
        let nl;
        while ((nl = buf.indexOf(10, start)) !== -1) {
          if (nl > start) this.handleLine(buf.toString('utf8', start, nl), file);
          start = nl + 1;
        }
        // Keep the unfinished last line (it may still be being written) for the next read.
        carry = Buffer.from(buf.subarray(start));
      });
      stream.on('end', () => {
        state.offset = end;
        state.carry = carry;
        resolve();
      });
      stream.on('error', () => resolve());
    });
  }

  handleLine(line, file) {
    this.stats.linesRead++;
    // Cheap substring checks first: most lines (request blobs, tool output) are skipped unparsed.
    const isAssistant = line.includes('"type":"assistant"') && line.includes('"usage"');
    const isTitle = line.includes('"type":"custom-title"');
    // What the user typed: not tool results, injected context or subagent traffic.
    const isPrompt = !isAssistant && line.includes('"type":"user"') && !line.includes('"type":"tool_result"') && !line.includes('"isMeta":true') && !line.includes('"isSidechain":true');
    if (!isAssistant && !isTitle && !isPrompt) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      this.stats.unreadableLines++;
      return;
    }
    if (entry.type === 'custom-title' && entry.sessionId && entry.customTitle) {
      this.session(entry.sessionId).title = String(entry.customTitle);
    } else if (entry.type === 'assistant') {
      this.noteReply(entry, file);
      this.handleAssistant(entry, file);
    } else if (entry.type === 'user' && isPrompt) {
      this.handlePrompt(entry, file);
    }
  }

  /** Keeps the first and latest thing the user asked for in each chat. */
  handlePrompt(entry, file) {
    if (entry.isMeta || entry.isSidechain || (entry.origin && entry.origin.kind !== 'human') || file.includes(SUBAGENT_DIR) || !entry.sessionId) return;
    const c = entry.message && entry.message.content;
    const raw = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
    const text = cleanPrompt(raw);
    if (!text) return;
    const ts = Date.parse(entry.timestamp) || 0;
    const s = this.session(entry.sessionId);
    s.prompts++;
    const substantial = text.length >= 25 && !FILLER.test(text);
    if (!s.firstPrompt || (substantial && !s.firstSubstantial)) {
      s.firstPrompt = text;
      s.firstPromptTs = ts;
      s.firstSubstantial = substantial;
    }
    if (ts >= s.lastPromptTs) {
      s.lastPrompt = text;
      s.lastPromptTs = ts;
    }
  }

  /** Keeps the latest thing Claude said in the main thread, and which files it changed. */
  noteReply(entry, file) {
    const msg = entry.message;
    if (!msg || !Array.isArray(msg.content) || entry.isSidechain === true || file.includes(SUBAGENT_DIR) || !entry.sessionId) return;
    const s = this.session(entry.sessionId);
    const ts = Date.parse(entry.timestamp) || 0;
    for (const block of msg.content) {
      if (!block) continue;
      if (block.type === 'text' && block.text && block.text.trim() && ts >= s.lastSayTs) {
        s.lastSay = clip(scrub(block.text.replace(/\s+/g, ' ').trim()), 420);
        s.lastSayTs = ts;
        s.lastSayKind = msg.model === '<synthetic>' ? 'notice' : 'claude'; // Claude Code's own notices, like a reached limit
      } else if (block.type === 'tool_use' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(block.name) && block.input && s.files.size < 2000) {
        const p = block.input.file_path || block.input.notebook_path;
        if (typeof p === 'string') s.files.add(p);
      }
    }
  }

  handleAssistant(entry, file) {
    const msg = entry.message;
    if (!msg || !msg.usage || msg.model === '<synthetic>') return;
    const key = `${msg.id || ''}:${entry.requestId || ''}`;
    if (key !== ':') {
      const first = this.seen.get(key);
      if (first) {
        // Same response, next content block: same usage, but this line may carry a tool call.
        this.stats.duplicateLines++;
        addTools(first, msg.content);
        if ((msg.usage.output_tokens || 0) > first.output) first.output = msg.usage.output_tokens;
        return;
      }
    }
    const ts = Date.parse(entry.timestamp);
    if (!Number.isFinite(ts)) {
      this.stats.unreadableLines++;
      return;
    }
    const u = msg.usage;
    const sessionId = entry.sessionId || path.basename(file, '.jsonl');
    const subagent = entry.isSidechain === true || file.includes(SUBAGENT_DIR);
    const rec = {
      ts,
      sessionId,
      model: msg.model || 'unknown',
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite1h: (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0,
      webSearches: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0,
      fast: u.speed === 'fast',
      subagent,
      tools: [], // names of the tools this response called
    };
    addTools(rec, msg.content);
    if (key !== ':') this.seen.set(key, rec);
    this.records.push(rec);
    this.stats.responses++;

    const s = this.session(sessionId);
    if (!s.firstTs || ts < s.firstTs) s.firstTs = ts;
    if (!s.lastTs || ts >= s.lastTs) s.lastTs = ts;
    if (!subagent) {
      if (entry.cwd) s.cwd = entry.cwd;
      if (entry.entrypoint) s.entrypoint = entry.entrypoint;
      if (entry.version) s.version = entry.version;
      if (entry.gitBranch) s.gitBranch = entry.gitBranch;
      // Context = everything the latest main-thread request was answered over.
      if (!s.contextTs || ts >= s.contextTs) {
        s.contextTs = ts;
        s.contextTokens = rec.input + rec.cacheWrite + rec.cacheRead;
        s.model = rec.model;
      }
    }
  }

  session(id) {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, title: null, cwd: null, entrypoint: null, version: null, gitBranch: null, model: null, firstTs: 0, lastTs: 0, contextTs: 0, contextTokens: 0, prompts: 0, firstSubstantial: false, firstPrompt: null, firstPromptTs: 0, lastPrompt: null, lastPromptTs: 0, lastSay: null, lastSayTs: 0, files: new Set() };
      this.sessions.set(id, s);
    }
    return s;
  }
}

function addTools(rec, content) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block && block.type === 'tool_use' && block.name && !rec.tools.includes(block.name)) rec.tools.push(block.name);
  }
}

function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

/** Hides things that look like keys or tokens, since summaries can be viewed remotely. */
function scrub(text) {
  return text
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|shpat|shpss|AKIA|AIza)[-_A-Za-z0-9]{12,}/g, '[hidden]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, '[hidden]')
    .replace(/\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{40,}={0,2}/g, '[hidden]');
}

const FILLER = /^(i hit my usage limit|continue|keep going|go on|go ahead|carry on|proceed|resume|yes|ok|okay|do it)\b/i;

/** The user's own words from a transcript line, or null for commands and injected text. */
function cleanPrompt(raw) {
  if (!raw) return null;
  let text = raw;
  const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
    if (!args || args[1].trim().length < 25) return null; // /clear, /model x and the like say nothing about the work
    text = `${cmd[1].trim()} ${args[1].trim()}`;
  }
  text = text.replace(/<(system-reminder|local-command-stdout|local-command-stderr|pasted_content|task-notification|ide_[a-z_]+)[^>]*>[\s\S]*?<\/\1>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text.startsWith('<') || /^(\[Usage limit|\[Request interrupted|This session is being continued|Caveat:|Base directory for this skill)/.test(text)) return null;
  return clip(scrub(text), 420);
}

module.exports = { TranscriptScanner, cleanPrompt, scrub, clip };
