# Build Prompt — "Token Burn" dashboard

Paste this into Claude Code (or any capable coding agent) to generate your own version. It's written as a spec so the agent can adapt it to your stack. Tweak the **Tech constraints** to match what you want (plain Node, Next.js, Azure SWA, etc.).

---

## Goal

Build a **local dashboard** that visualizes my **Claude Code** (and optionally **Codex CLI**) token usage by reading the session logs those tools already write to my home directory. No external services, no API keys, no telemetry — it reads local files and renders in the browser.

## Data sources (read-only, on my machine)

1. **Claude Code transcripts** — `~/.claude/projects/**/*.jsonl` (newline-delimited JSON). Each `assistant` line has:
   - `timestamp` (ISO), `sessionId`, `message.model`, and `message.usage` with `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`.
   - Treat a day's Claude total as `input + output + cache_read + cache_creation`. Bucket by the UTC date of `timestamp`. Also accumulate per-session totals (keyed by `sessionId`) and per-model totals.
2. **Claude session metadata** — `~/.claude/usage-data/session-meta/*.json` (filename = sessionId). Fields include `project_path`, `first_prompt`, `tool_counts`, `languages`, `git_commits`, `git_pushes`, `files_modified`, `lines_added/removed`, `uses_mcp/web_search/web_fetch/task_agent`. Use these to classify each session into a **work family**.
3. **Codex CLI rollouts** — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Token usage arrives as events: `payload.type === "token_count"`, with `payload.info.last_token_usage` (per-turn delta: `input_tokens`, `output_tokens`, `cached_input_tokens`, `reasoning_output_tokens`, `total_tokens`). Sum the **per-turn deltas** bucketed by each event's date. Session id is the uuid in the filename.

ChatGPT has no local log — exclude it (leave a hook for a manual export).

## Backend payload

Expose `GET /api/token-burn` (and a `?refresh=1`) returning JSON:

```
{
  generatedAt, timezone:'UTC',
  platforms: { claude, codex, chatgpt:false },
  totals: { all, claude, codex, messages, sessions, codexSessions, firstDay, lastDay,
            estimated, estimatedDays, estimatedRange },
  modelTotals,
  daily:   [ { date, claude, codex, total, messages, estimated? } ],   // measured + estimated gap days
  weekly:  [ { week, total, claude, codex } ],
  movingAvg30: [ { date, total, claude, codex, avg30 } ],
  drivers: [ { family, label, kind:'computer'|'assistant', tokens, sessions, sharePct, evidence } ],
  workSplit: { computer, assistant, computerPct, assistantPct },
  recent:  { dayToDate, dayToDateDate, last7, last30, peakDay:{date,total} },
  fermi:   [ { label, value, detail } ]
}
```

Details:
- **Work families** from session-meta: classify into `coding / debugging / automation / ops / writing / research / qa / other`. Authored code (edits, lines, commits, languages) ⇒ coding (or debugging if the first prompt is fix-flavored); MCP+n8n ⇒ automation; deploy/push with little authoring ⇒ ops; web/research prompts ⇒ research; otherwise writing/qa/other. `kind` = computer for artifact-producing families, assistant otherwise. Join each session's **family** to its **token total** (from the transcript pass, by sessionId) to get `drivers`. Add Codex as its own driver group.
- **Gap estimation:** if the merged daily series has an internal gap ≥ 14 days (e.g. logs were pruned), fill it with an interpolated estimate — linear between the 7-day means on each side, modulated by the weekday/weekend ratio — flagged `estimated:true`. **Keep estimates out of headline totals**; report them separately.
- **Fermi:** words ≈ tokens × 0.75; derive novels (90k words), War & Peace (587k), reading-days (250 wpm), spoken-years (130 wpm).
- Cache the composed result ~5 min so it doesn't re-parse hundreds of MB on every request.

## Frontend (vanilla JS, no chart libraries — hand-built SVG/CSS)

- **Daily heatmap, three stacked lanes** (Total / Claude / Codex), GitHub-contributions style (columns = weeks, rows Sun–Sat), month labels on top. **Color each cell by the day's percentile rank within its own lane** (so a few low + many high days still span light→dark). Per-lane brand colors: Total = green, Claude = clay/orange, Codex = blue. Range presets: 24h, 7d, 30d, 90, 180, full calendar year, all. Badge the **top-5 days** (1–5) on the focused lane. Hover card shows the day's Total/Claude/Codex; clicking a day opens a detail drawer.
- **Rolling KPI cards** (day-to-date / 7d / 30d / peak) as a side rail next to the heatmap.
- **Stat cards** for Total/Claude/Codex that **filter the whole view** when clicked (heatmap lane, drivers, line) with a clear active state.
- **Weekly line chart** — linear y-axis with equal-sized gridlines, one line per platform in its brand color; wide invisible hover bands → tooltip; auto-rescale when filtered to a small platform.
- **Driver dot-plot** (log-positioned) with the computer-vs-assistant split bar.
- **30-day moving-average table** and **Fermi scale-equivalent cards**.
- Loads from `/api/token-burn`, falling back to a static `/data/token-burn.json` snapshot for read-only hosting.

## Tech constraints (edit to taste)

- Default: a **zero-dependency Node HTTP server** (`node server.js`) serving static files + the API. Swap for Next.js/Express/Azure Functions if preferred.
- Frontend is **plain HTML/CSS/JS** — no frameworks, no build step, no chart libs. Hand-roll the SVG/CSS.
- Light theme; system font stack; subtle shadows; rounded stat cards with a colored top border.

## Acceptance

- `node server.js` → dashboard at `http://localhost:PORT`, populated from my real local data, **no console errors**.
- Numbers reconcile with a manual spot-check (e.g. sum one day's Claude usage from the raw `.jsonl`).
- No prompt text or file contents appear anywhere in the payload — only counts, timestamps, models, and aggregate metadata.
- A `npm run snapshot` writes the static JSON for read-only hosting.
