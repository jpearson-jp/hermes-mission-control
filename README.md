# Mission Control

A Hermes dashboard plugin that puts a multi-bot estate on one screen: **what needs a decision**,
what is stuck and why, and what each bot is actually for.

Ships both halves of a unified package:

- `dashboard/plugin_api.py` — every route, mounted by the dashboard at `/api/plugins/mission-control/*`
- `desktop/plugin.js` — the Electron half (pages, sidebar rows, a status-bar chip, a workspace tab,
  ⌘K commands, an ask watcher), talking to the same namespace over `ctx.rest`

## Install

Click:

```
hermes://plugin/install?repo=jpearson-jp/hermes-mission-control&enable=1
```

Or from a shell:

```bash
hermes plugins install jpearson-jp/hermes-mission-control
```

The desktop half ships **opt-in**: it inventories in Capabilities → Plugins and stays disabled until
you toggle it, matching the Python half's `plugins.enabled` gate. The copy the app makes is
**app-level** — it lives once in `<hermes home>/desktop-plugins/` and is visible in every profile,
and it neither appears nor disappears when you switch the active profile.

### Manual fallback (no installer)

```bash
mkdir -p ~/.hermes/desktop-plugins/mission-control
curl -fsSL https://raw.githubusercontent.com/jpearson-jp/hermes-mission-control/main/desktop/plugin.js \
  -o ~/.hermes/desktop-plugins/mission-control/plugin.js
```

Prefer the repo raw URL: `<your-hermes-url>/dashboard-plugins/...` is served by the dashboard and
now answers 302 to anything without the app's own session, so it is not a scriptable download.

`desktop/dist/` in this repo always holds the current copy, so the download can come from the repo
raw URL just as well as from a running dashboard.

## What it shows

| Page | What it answers |
|---|---|
| Mission Control | what is waiting on the owner, what is stuck, what is moving, right now |
| Insights | 24h/7d shape: throughput, cycle time, why cards are stuck, who is working, your attention |
| Estate | every bot grouped by the domain in its own profile description, its schedules, its load |

Write actions are deliberately narrow, and every one goes through the same code path the CLI uses
(so each records a normal kanban event): answer a framed ask, comment, assign an owner.

## Requirements

The backend reads the local Hermes install: the kanban boards under
`<hermes home>/kanban/boards/*/kanban.db`, `<hermes home>/cron/jobs.json`, and the profile
directories. It needs no credentials of its own.
