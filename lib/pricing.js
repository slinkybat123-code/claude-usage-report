'use strict';
/**
 * What each API response would cost at Anthropic's list prices (USD per
 * million tokens). On a subscription plan this is not a bill: it is the
 * API-equivalent value of the usage, the same idea as /cost in Claude Code.
 *
 * Prices as of 2026-11. Cache writes are 1.25x input for the 5-minute cache
 * and 2x for the 1-hour cache; cache reads have their own rate per model.
 * Rows for retired models are best-effort.
 */
const PRICES_AS_OF = '2026-11-03';

// [match, label, input, output, cacheRead]. First match wins, so newer ids come first.
const TABLE = [
  [/fable-5-2|mythos-5-2/, 'Fable 5.2', 8, 40, 0.2],
  [/fable-5-1|mythos-5-1/, 'Fable 5.1', 10, 50, 0.25],
  [/fable-5|mythos/, 'Fable 5', 10, 50, 1],
  [/opus-5-5/, 'Opus 5.5', 4, 20, 0.2],
  [/opus-5|opus-4-[5-8]/, 'Opus 5 / 4.5-4.8', 5, 25, 0.5],
  [/opus/, 'Opus (older)', 15, 75, 1.5],
  [/sonnet-5-5/, 'Sonnet 5.5', 2, 10, 0.1],
  [/sonnet-5/, 'Sonnet 5', 2, 10, 0.2],
  [/sonnet/, 'Sonnet 4.x', 3, 15, 0.3],
  [/haiku-5-5/, 'Haiku 5.5', 0.1, 0.5, 0.01],
  [/haiku-4-5/, 'Haiku 4.5', 1, 5, 0.1],
  [/haiku/, 'Haiku (older)', 0.8, 4, 0.08],
];
const FALLBACK = ['Unknown model (priced as Opus 5.5)', 4, 20, 0.2];
const HAIKU_55_LONG = { threshold: 100e3, input: 0.5, output: 2.5, cacheRead: 0.05 }; // prompts over 100K tokens

const cache = new Map();
function priceFor(model) {
  let p = cache.get(model);
  if (!p) {
    const row = TABLE.find(([re]) => re.test(model || ''));
    const [label, input, output, cacheRead] = row ? row.slice(1) : FALLBACK;
    p = { model, label, input, output, cacheRead, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2, known: !!row, longPrompt: /haiku-5-5/.test(model || '') ? HAIKU_55_LONG : null };
    cache.set(model, p);
  }
  return p;
}

/**
 * Cost of one scanner record, split by token type.
 * rec: { model, input, output, cacheRead, cacheWrite, cacheWrite1h, fast }
 */
function costOf(rec) {
  const p = priceFor(rec.model);
  let { input, output, cacheRead } = p;
  if (p.longPrompt && rec.input + rec.cacheWrite + rec.cacheRead > p.longPrompt.threshold) ({ input, output, cacheRead } = p.longPrompt);
  const k = (rec.fast ? 2 : 1) / 1e6; // fast mode bills at twice the standard rate
  const w1h = Math.min(rec.cacheWrite1h || 0, rec.cacheWrite);
  const out = {
    input: rec.input * input * k,
    output: rec.output * output * k,
    cacheRead: rec.cacheRead * cacheRead * k,
    cacheWrite: (w1h * 2 + (rec.cacheWrite - w1h) * 1.25) * input * k,
  };
  out.total = out.input + out.output + out.cacheRead + out.cacheWrite;
  return out;
}

module.exports = { PRICES_AS_OF, priceFor, costOf };
