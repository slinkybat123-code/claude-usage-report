/**
 * plan-usage-reporter — Claude Mod for Claude Usage Monitor
 *
 * After each turn, and whenever a plan-limit window moves a whole point, writes
 * this session's figures to <dataDir>/sessions/<sessionId>.json:
 *   - the rate-limit windows the last API response reported (what /usage shows:
 *     5-hour and weekly percent used, and when each resets)
 *   - the context window's fill
 *   - the session's /cost total (API-equivalent dollars)
 *
 * Observe-only: it never changes, delays or denies anything, and a failed write
 * is ignored. Nothing leaves the machine.
 *
 * Needs Claude Code >= 2.1.287 (mods on by default).
 *
 * Options:
 *   dataDir: string  where to write (default: <CLAUDE_CONFIG_DIR or ~/.claude>/usage-monitor)
 */
import type { Register } from 'claude-code'

export const register: Register = (on, options) => {
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    try {
      let dataDir = typeof options.dataDir === 'string' ? options.dataDir.trim() : ''
      if (!dataDir) {
        const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
        const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
        if (!configDir && !home) return result
        dataDir = `${configDir || `${home}/.claude`}/usage-monitor`
      }
      const sessionId = await $.session.id()
      const record = {
        v: 1,
        sessionId,
        cwd: await $.session.cwd(),
        model: await $.session.model(),
        updatedAt: Date.now(),
        rateLimits: e.rateLimits.map((w) => ({ kind: w.kind, percentUsed: w.percentUsed, resetsAt: w.resetsAt ?? null })),
        context: { tokens: e.context.tokens ?? null, window: e.context.window, percent: e.context.percent ?? null },
        costUsd: e.cost ? e.cost.usd : null,
      }
      await $.fs.write(`${dataDir}/sessions/${sessionId}.json`, JSON.stringify(record))
    } catch {
      // Reporting is best effort: never disturb the session.
    }
    return result
  })
}
