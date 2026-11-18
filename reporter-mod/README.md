# plan-usage-reporter

A Claude Code mod (plugin with a function-hooks module) that feeds plan-limit
data to Claude Usage Monitor. `/usage` figures are not stored in Claude Code's
transcripts, so the monitor cannot read them from disk without this.

After each turn, and whenever a limit window moves a whole point, it writes
`~/.claude/usage-monitor/sessions/<sessionId>.json` with:

- the rate-limit windows the last API response reported (`five_hour`,
  `seven_day`): percent used and reset time
- the context window's fill (tokens, window size, percent)
- the session's `/cost` total in US dollars (API-equivalent)

It only observes: it never changes, delays or denies a request, and a failed
write is ignored. Nothing is sent anywhere.

Needs Claude Code 2.1.287 or later. Installed at
`~/.claude/skills/plan-usage-reporter/`, it loads in every new session.
Sessions already running pick it up when restarted.

Option `dataDir` (in `pluginConfigs["plan-usage-reporter@skills-dir"].options`
of `~/.claude/settings.json`) changes where it writes.

Install or remove it from the monitor's dashboard, or by copying/deleting this
folder.
