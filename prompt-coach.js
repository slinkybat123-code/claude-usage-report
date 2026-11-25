/* Prompt breakdown: which words can go, what's missing, a score, tips and a shorter version.
   Runs in the browser (window.PromptCoach) and in Node (require) for the tests. Rules only, no AI:
   it works offline and costs nothing. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PromptCoach = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Words that can go without changing what you asked for.
  const POLITE = ['would you mind', 'i would like you to', "i'd like you to", 'i want you to', 'i need you to', 'if you could', 'if possible', 'could you', 'can you', 'would you', 'please', 'kindly', 'thank you', 'thanks'];
  const FILLER = ['a little bit', 'kind of', 'sort of', 'pretty much', 'a bit', 'you know', 'i think', 'i guess', 'i feel like', 'basically', 'actually', 'literally', 'honestly', 'simply', 'just', 'really', 'very', 'maybe', 'perhaps', 'obviously', 'totally', 'definitely', 'quite', 'somewhat'];
  // Words that don't say what you mean.
  const VAGUE = ['make it better', 'make it nicer', 'make it work', 'improve it', 'improve this', 'fix it', 'fix this', 'fix that', 'something', 'stuff', 'things', 'etc', 'and so on', 'whatever', 'somehow', 'work properly', 'the usual'];

  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const phraseRe = (list) => new RegExp(`(?<![\\w'’])(?:${list.map((p) => p.split(' ').map(escape).join('\\s+')).join('|')})(?![\\w'’])`, 'gi');
  const RE = { polite: phraseRe(POLITE), filler: phraseRe(FILLER), vague: phraseRe(VAGUE) };

  const WORD = /[A-Za-z0-9][\w'’./-]*/g;
  const countWords = (s) => (s.match(WORD) || []).length;
  /** Names a file, path, function or code: where Claude should look. */
  const LOCATION = /[\w-]+\.[a-z]{1,5}\b(?!\s*[a-z]\.)|[\w.-]*[/\\][\w.-]+|`[^`]+`|\b\w+\(\)|\b[a-z]+[A-Z]\w*\b|\b[a-z]+_[a-z_]+\b|\b(?:line|lines)\s+\d+/;
  /** Says what finished looks like. */
  const DONE = /\b(?:so that|so (?:the|it|they|we|i|my|that)\b|should|must|make sure|until|expect(?:ed|s)?|tests? pass|passes|verify|done when|without (?:breaking|changing)|instead of)\b/i;
  /** Asks for a change to code (then where to look matters). */
  const CHANGE = /\b(?:fix|change|update|add|remove|delete|refactor|edit|rename|move|implement|build|make|create|write|debug|style|replace|clean ?up|optimi[sz]e|improve)\b/i;
  /** A quick answer inside a running chat ("go", "yes", "ok continue"): nothing to coach. */
  const REPLY = /^(?:ok(?:ay)?|yes|yep|yeah|y|no|nope|go|go ahead|go on|continue|keep going|proceed|do it|sure|next|stop|thanks|thank you|ty|approved?|lgtm|done|sounds good|looks good|perfect|great)(?:[\s,.!]+(?:ok(?:ay)?|yes|go|go ahead|continue|do it|please|thanks|proceed|next))*[\s.!]*$/i;
  const SPLIT =/\band also\b|\balso\b|\bthen\b|\bplus\b|\bas well as\b|;|\n\s*(?:[-*•]|\d+[.)])\s+/i;

  function find(text, re, kind, taken) {
    const out = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const r = { start: m.index, end: m.index + m[0].length, text: m[0], kind };
      if (!taken.some((t) => r.start < t.end && t.start < r.end)) {
        out.push(r);
        taken.push(r);
      }
    }
    return out;
  }

  function repeats(text, taken) {
    const out = [];
    const re = /\b([A-Za-z]+)\s+(\1)\b/gi;
    let m;
    while ((m = re.exec(text))) {
      const start = m.index + m[0].length - m[2].length;
      const r = { start, end: start + m[2].length, text: m[2], kind: 'repeat' };
      if (!taken.some((t) => r.start < t.end && t.start < r.end)) {
        out.push(r);
        taken.push(r);
      }
    }
    return out;
  }

  /** The prompt with the wasted words taken out and the punctuation tidied. */
  function shorten(text, ranges) {
    let s = '';
    let at = 0;
    for (const r of ranges.slice().sort((a, b) => a.start - b.start)) {
      s += text.slice(at, r.start);
      at = r.end;
    }
    s += text.slice(at);
    s = s.replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([,.;:!?])/g, '$1')
      .replace(/([?.!])[!.,]+/g, '$1')
      .replace(/[,;:]+([.!?])/g, '$1')
      .replace(/,(\s*,)+/g, ',')
      .replace(/^[\s,.;:!]+/, '')
      .replace(/[,;:\s]+$/, '')
      .trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  const list = (items) => items.map((t) => `"${t}"`).join(', ');

  function analyzePrompt(input) {
    const text = String(input == null ? '' : input).trim();
    if (!text) return null;
    const partial = /…$|\.\.\.$/.test(text);
    if (REPLY.test(text)) {
      return {
        text, partial: false, reply: true, words: countWords(text), tokens: Math.max(1, Math.round(text.length / 4)),
        wasted: [], wastedWords: 0, wastedShare: 0, vague: [], tasks: 1, asksChange: false,
        checks: { enoughContext: true, location: true, doneWhen: true, oneTask: true }, score: null, grade: 'Quick reply',
        tips: [{ title: 'Quick reply', detail: 'A short answer in a running chat. Nothing to fix: Claude already has the context.' }], shorter: text,
      };
    }
    const taken = [];
    const polite = find(text, RE.polite, 'polite', taken);
    const filler = find(text, RE.filler, 'filler', taken);
    const doubled = repeats(text, taken);
    const vague = find(text, RE.vague, 'vague', taken.slice());
    const wasted = [...polite, ...filler, ...doubled].sort((a, b) => a.start - b.start);

    const words = countWords(text);
    const wastedWords = wasted.reduce((n, w) => n + countWords(w.text), 0);
    const wastedShare = words ? wastedWords / words : 0;
    const tasks = Math.max(text.split(SPLIT).filter((p) => countWords(p) >= 2).length, (text.match(/\?/g) || []).length, 1);
    const asksChange = CHANGE.test(text);
    const checks = {
      enoughContext: words >= 5,
      location: LOCATION.test(text),
      doneWhen: DONE.test(text),
      oneTask: tasks < 3,
    };

    let score = 100 - Math.min(25, Math.round(wastedShare * 100));
    if (!checks.enoughContext) score -= 25;
    if (asksChange && !checks.location) score -= 15;
    if (asksChange && !checks.doneWhen) score -= 10;
    score -= Math.min(20, vague.length * 10);
    if (!checks.oneTask) score -= 10;
    score = Math.max(0, Math.min(100, score));
    const grade = score >= 80 ? 'Clear' : score >= 55 ? 'Could be clearer' : 'Vague';

    const tips = [];
    if (!checks.enoughContext) tips.push({ title: 'Give it more context', detail: 'Very short prompts make Claude guess. Say what you are working on, what happens now, and what you want instead.' });
    if (vague.length) tips.push({ title: 'Replace vague words', detail: `${list([...new Set(vague.map((v) => v.text.toLowerCase()))])} can mean many things. Say exactly what should change: which part, what it should do, and what it does now.` });
    if (asksChange && !checks.location) tips.push({ title: 'Say where to look', detail: 'Name the file, function or page, for example public/app.js, renderLimits() or "the Friends page". Claude then opens one file instead of searching the project, and searching is often the most expensive part of a chat.' });
    if (asksChange && !checks.doneWhen) tips.push({ title: 'Say what done looks like', detail: 'Add how you will know it worked: "so that the button opens the panel", "the tests should pass", "it should show the total". Claude can then check its own work instead of stopping early or doing too much.' });
    if (!checks.oneTask) tips.push({ title: 'Split it up', detail: `This asks for about ${tasks} things at once. One prompt per change (or a numbered list) keeps each step small and easy to check, and /clear between unrelated tasks keeps the chat short and cheap.` });
    if (wastedWords) {
      const tokens = Math.max(1, Math.round(wasted.reduce((n, w) => n + w.text.length, 0) / 4));
      tips.push({ title: 'Cut the filler', detail: `${wastedWords} of ${words} words (${Math.round(wastedShare * 100)}%) can go without changing the meaning: ${list([...new Set(wasted.map((w) => w.text.toLowerCase()))])}. On their own they cost little, about ${tokens} token${tokens === 1 ? '' : 's'} re-read with every later reply, but a tighter prompt is quicker to read and easier to get right.` });
    }
    if (!tips.length) tips.push({ title: 'Nicely done', detail: 'Specific, says where to look and what done means. Nothing to change.' });

    return {
      text, partial, reply: false, words, tokens: Math.max(1, Math.round(text.length / 4)),
      wasted, wastedWords, wastedShare, vague, tasks, asksChange, checks, score, grade, tips,
      shorter: wasted.length ? shorten(text, wasted) : text,
    };
  }

  /** Every prompt at once: average score, commonest filler, what is most often missing, weakest first. */
  function summarizePrompts(items) {
    const all = items.map((it) => ({ ...it, analysis: analyzePrompt(it.text) })).filter((it) => it.analysis);
    const done = all.filter((it) => !it.analysis.reply);
    const counts = new Map();
    for (const it of done) for (const w of it.analysis.wasted.filter((x) => x.kind !== 'repeat')) {
      const k = w.text.toLowerCase().replace(/\s+/g, ' ');
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const words = done.reduce((n, it) => n + it.analysis.words, 0);
    const wastedWords = done.reduce((n, it) => n + it.analysis.wastedWords, 0);
    return {
      count: done.length,
      replies: all.length - done.length,
      avgScore: done.length ? Math.round(done.reduce((n, it) => n + it.analysis.score, 0) / done.length) : null,
      words, wastedWords, wastedShare: words ? wastedWords / words : 0,
      topWasted: [...counts].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text)).slice(0, 8),
      missingLocation: done.filter((it) => it.analysis.asksChange && !it.analysis.checks.location).length,
      missingDone: done.filter((it) => it.analysis.asksChange && !it.analysis.checks.doneWhen).length,
      multiTask: done.filter((it) => !it.analysis.checks.oneTask).length,
      vague: done.filter((it) => it.analysis.vague.length).length,
      grades: ['Clear', 'Could be clearer', 'Vague'].map((g) => ({ grade: g, count: done.filter((it) => it.analysis.grade === g).length })),
      worst: done.slice().sort((a, b) => a.analysis.score - b.analysis.score),
    };
  }

  return { analyzePrompt, summarizePrompts };
});
