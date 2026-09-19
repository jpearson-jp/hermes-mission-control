/**
 * Mission Control — the DESKTOP half of the `mission-control` package.
 *
 * The Python half beside this file (`dashboard/plugin_api.py`) already owns every route; this file
 * is pure UI over it through `ctx.rest` (which is scoped to /api/plugins/<id>/ by construction).
 * Plugin id MUST equal the package folder name ('mission-control') so the copy the Electron main
 * process makes into $HERMES_HOME/desktop-plugins/ resolves to the same backend namespace.
 *
 * Loaded UNCOMPILED as ESM: no JSX (jsx()/jsxs() only), and the ONLY importable specifiers are
 * `@hermes/plugin-sdk`, `react` and `react/jsx-runtime`. Colours come from theme vars, never
 * literals, so it reskins with the app.
 */

import {
  Badge, Button, cn, EmptyState, ErrorState, GlyphSpinner, haptic, host,
  KEYBINDS_AREA, PALETTE_AREA, queryClient, relativeTime, ROUTES_AREA, SIDEBAR_NAV_AREA,
  Separator, STATUSBAR_AREAS, Tip, TRANSCRIPT_DIRECTIVE_AREA, useQuery
} from '@hermes/plugin-sdk'
import { useEffect, useMemo, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'mission-control'
const WAITING = '/mission-control'
const INSIGHTS = '/mission-control/insights'
const ESTATE = '/mission-control/estate'
const WAITING_ON_ME = '/mission-control/waiting'
const PROJECTS = '/mission-control/projects'
const FLOW = '/mission-control/flow'

const CSS = `
.mc-page{display:flex;flex-direction:column;gap:14px;padding:14px 16px 40px;height:100%;overflow:auto}
.mc-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px}
.mc-tile{border:1px solid var(--ui-stroke-secondary);border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:2px}
.mc-tile-k{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--ui-text-quaternary)}
.mc-tile-v{font-size:20px;line-height:24px;font-weight:600;color:var(--ui-text-primary)}
.mc-tile-n{font-size:11px;color:var(--ui-text-tertiary)}
.mc-tile[data-tone=warn]{border-color:color-mix(in srgb,var(--ui-accent) 45%,var(--ui-stroke-secondary))}
.mc-tile[data-tone=warn] .mc-tile-v{color:var(--ui-accent)}
.mc-sec{border:1px solid var(--ui-stroke-secondary);border-radius:6px;overflow:hidden}
.mc-sec-h{display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--ui-stroke-secondary)}
.mc-sec-t{font-size:12px;font-weight:600;color:var(--ui-text-primary)}
.mc-sec-s{font-size:11px;color:var(--ui-text-tertiary)}
.mc-sec-b{padding:10px;display:flex;flex-direction:column;gap:8px}
.mc-row{border:1px solid var(--ui-stroke-secondary);border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.mc-row-t{font-size:12.5px;color:var(--ui-text-primary)}
.mc-row-m{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11px;color:var(--ui-text-tertiary);align-items:center}
.mc-ask{font-size:12px;line-height:1.45;color:var(--ui-text-secondary);white-space:pre-wrap;
  border-left:2px solid var(--ui-stroke-secondary);padding-left:8px;max-height:190px;overflow:auto}
.mc-opt{display:flex;gap:8px;align-items:flex-start;width:100%;text-align:left;cursor:pointer;
  border:1px solid var(--ui-stroke-secondary);border-radius:5px;padding:6px 8px;font-size:12px;line-height:1.4;
  background:transparent;color:var(--ui-text-secondary)}
.mc-opt:hover{border-color:var(--ui-accent)}
.mc-opt[data-on=true]{border-color:var(--ui-accent);background:color-mix(in srgb,var(--ui-accent) 12%,transparent)}
.mc-opt-n{font-weight:700;color:var(--ui-text-primary);min-width:12px}
.mc-chart{display:flex;flex-direction:column;gap:6px}
.mc-stack{display:flex;height:22px;border:1px solid var(--ui-stroke-secondary);border-radius:4px;overflow:hidden}
.mc-stack>span{min-width:2px}
.mc-legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--ui-text-tertiary)}
.mc-legend i{width:9px;height:9px;border-radius:2px;display:inline-block;margin-right:4px}
.mc-bars{display:flex;align-items:flex-end;gap:2px;height:110px}
.mc-bars-col{flex:1 1 0;display:flex;align-items:flex-end;gap:1px;min-width:2px}
.mc-bars-col>span{flex:1 1 0;min-height:1px;border-radius:1px 1px 0 0}
.mc-spark{width:100%;height:78px;display:block}
.mc-spark-line{fill:none;stroke:var(--ui-accent);stroke-width:1.6;vector-effect:non-scaling-stroke}
.mc-spark-area{fill:color-mix(in srgb,var(--ui-accent) 20%,transparent)}
.mc-hbars{display:flex;flex-direction:column;gap:5px}
.mc-hbar{display:grid;grid-template-columns:110px 1fr 52px;gap:8px;align-items:center;font-size:11.5px;color:var(--ui-text-tertiary)}
.mc-hbar-track{background:color-mix(in srgb,var(--ui-stroke-secondary) 70%,transparent);height:9px;border-radius:3px;overflow:hidden}
.mc-hbar-v{text-align:right;font-variant-numeric:tabular-nums}
.mc-grid2{display:grid;grid-template-columns:1fr;gap:14px}
@media(min-width:1100px){.mc-grid2{grid-template-columns:1.15fr .85fr;align-items:start}}
.mc-c1{background:var(--ui-accent)}
.mc-c2{background:color-mix(in srgb,var(--ui-accent) 55%,transparent)}
.mc-c3{background:color-mix(in srgb,var(--ui-accent) 30%,transparent)}
.mc-c4{background:color-mix(in srgb,var(--ui-text-quaternary) 70%,transparent)}
.mc-dot{width:7px;height:7px;border-radius:50%;background:var(--ui-accent);display:inline-block}
.mc-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.mc-search { background: transparent; border: 1px solid var(--ui-stroke-secondary); border-radius: 5px; padding: 3px 8px; font-size: 11px; color: var(--ui-text-secondary); }
.mc-card { border: 1px solid var(--ui-stroke-secondary); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.mc-card-h { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.mc-card-t-inline { font-size: 13px; font-weight: 600; color: var(--ui-text-primary); }
.mc-chips { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.mc-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--ui-text-secondary); border: 1px solid var(--ui-stroke-secondary); border-radius: 999px; padding: 1px 8px; }
.mc-chip-x { background: transparent; border: 0; color: var(--ui-text-tertiary); cursor: pointer; font-size: 11px; padding: 0 2px; }
.mc-select { background: transparent; color: var(--ui-text-secondary); font-size: 11px; border: 1px solid var(--ui-stroke-secondary); border-radius: 5px; padding: 2px 6px; }
.mc-ask-foot { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.mc-note { font-size: 11px; color: var(--ui-text-secondary); }
.mc-row-click { cursor: pointer; }
.mc-row-click:hover { background: var(--chrome-action-hover, transparent); }
.mc-tiles-sm .mc-tile-v, .mc-tiles-sm { font-size: 12px; }
.mc-mono { font-family: var(--ui-font-mono, ui-monospace, monospace); font-size: 11px; color: var(--ui-text-tertiary); }
.mc-dim { font-size: 11px; color: var(--ui-text-tertiary); }
.mc-chip-on { border-color: var(--ui-accent); color: var(--ui-text-primary); }
.mc-chip-hot { border-color: color-mix(in srgb,var(--ui-accent) 55%,var(--ui-stroke-secondary)); color: var(--ui-accent); }
.mc-chip-warn { border-color: color-mix(in srgb,var(--ui-text-quaternary) 60%,var(--ui-stroke-secondary)); }
.mc-chip-ok { border-color: color-mix(in srgb,var(--ui-text-quaternary) 40%,var(--ui-stroke-secondary)); }
.mc-chip-dim { opacity: .6; }
.mc-flow { display: flex; flex-direction: column; gap: 10px; }
.mc-flow-svg { width: 100%; height: auto; display: block; }
.mc-flow-band { stroke: var(--ui-stroke-secondary); }
.mc-flow-band-ok { fill: color-mix(in srgb,var(--ui-accent) 26%,transparent); }
.mc-flow-band-warn { fill: color-mix(in srgb,var(--ui-accent) 40%,transparent); }
.mc-flow-band-hot { fill: color-mix(in srgb,var(--ui-accent) 62%,transparent); }
.mc-flow-band-idle { fill: color-mix(in srgb,var(--ui-text-quaternary) 30%,transparent); }
.mc-flow-band[data-hot=true] { stroke: var(--ui-accent); stroke-width: 1.5; }
.mc-flow-link { fill: color-mix(in srgb,var(--ui-accent) 14%,transparent); }
.mc-flow-link[data-idle=true] { fill: color-mix(in srgb,var(--ui-text-quaternary) 20%,transparent); }
.mc-flow-rework { fill: none; stroke: var(--ui-text-quaternary); stroke-width: 1; stroke-dasharray: 3 3; }
.mc-flow-num { font-size: 13px; font-weight: 600; fill: var(--ui-text-primary); }
.mc-flow-lbl { font-size: 10px; fill: var(--ui-text-tertiary); }
.mc-flow-stages { display: grid; grid-template-columns: repeat(auto-fit,minmax(168px,1fr)); gap: 8px; }
.mc-flow-stage { border: 1px solid var(--ui-stroke-secondary); border-radius: 6px; padding: 6px 8px; display: flex; flex-direction: column; gap: 2px; }
.mc-flow-stage[data-tone=hot] { border-color: color-mix(in srgb,var(--ui-accent) 50%,var(--ui-stroke-secondary)); }
.mc-flow-stage-h { display: flex; gap: 6px; align-items: center; justify-content: space-between; }
.mc-flow-stage-t { font-size: 11.5px; color: var(--ui-text-primary); }
.mc-flow-stage-v { font-size: 19px; font-weight: 600; line-height: 22px; color: var(--ui-text-primary); }
.mc-flow-stage[data-tone=hot] .mc-flow-stage-v { color: var(--ui-accent); }
.mc-flow-stage-m { font-size: 10px; color: var(--ui-text-tertiary); }
.mc-rail { display: flex; flex-wrap: wrap; gap: 6px; }
.mc-rail-box { border: 1px solid var(--ui-stroke-secondary); border-radius: 6px; padding: 5px 9px; display: flex; flex-direction: column; gap: 1px; }
.mc-rail-box[data-hot=true] { border-color: color-mix(in srgb,var(--ui-accent) 50%,var(--ui-stroke-secondary)); }
.mc-rail-k { font-size: 9px; text-transform: uppercase; letter-spacing: .07em; color: var(--ui-text-quaternary); }
.mc-rail-v { font-size: 15px; font-weight: 600; color: var(--ui-text-primary); }
.mc-rail-box[data-hot=true] .mc-rail-v { color: var(--ui-accent); }
`

// ---------------------------------------------------------------- helpers

function useCss() {
  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.append(style)
    return () => style.remove()
  }, [])
}

// ctx.rest is the ONLY sanctioned door to our own backend: it resolves the namespace AND the auth
// for whichever topology the window is in (local, SSH, URL+token, OAuth). A bare fetch() would work
// against a loopback backend and silently fail against a remote one, so nothing here calls fetch().
let rest = () => Promise.reject(new Error('mission-control: plugin not registered yet'))

/** Polling reader over the plugin's own REST namespace; React Query owns cache + dedupe. */
function useRest(path, refetchInterval = 30000) {
  return useQuery({
    queryKey: [ID, path],
    queryFn: () => rest(path),
    refetchInterval,
    staleTime: 5000,
    retry: 1
  })
}

function quiet(fn) {
  try { fn() } catch { /* plugin actions must never take the app down */ }
}

// Relative age of a WIRE timestamp. The plugin's own REST payloads carry ISO-8601 STRINGS —
// `generated_at` from plugin_api.py's datetime.isoformat(), `next_run_at` straight out of
// jobs.json, `since` from _iso() — while the SDK's relativeTime() takes epoch MILLISECONDS and
// throws `RangeError: Value need to be finite number for
// Intl.RelativeTimeFormat.prototype.format()` on anything non-finite. That throw reached the
// app's error boundary and blanked the whole page on every load. (The web half of this plugin
// formats the same strings with hhmm(); this is the desktop half's equivalent.)
function ago(value) {
  if (value == null || value === '') return '—'
  const ms = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(ms) ? relativeTime(ms) : '—'
}

function fmtAge(seconds) {
  if (seconds == null) return '—'
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`
}

function fmtNum(n) {
  if (n == null) return '—'
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function Tile({ k, v, n, tone }) {
  return jsxs('div', { className: 'mc-tile', 'data-tone': tone, children: [
    jsx('div', { className: 'mc-tile-k', children: k }),
    jsx('div', { className: 'mc-tile-v', children: v }),
    n ? jsx('div', { className: 'mc-tile-n', children: n }) : null
  ] })
}

function Section({ title, sub, right, children }) {
  return jsxs('div', { className: 'mc-sec', children: [
    jsxs('div', { className: 'mc-sec-h', children: [
      jsx('div', { className: 'mc-sec-t', children: title }),
      sub ? jsx('div', { className: 'mc-sec-s', children: sub }) : null,
      jsx('div', { style: { flex: '1 1 auto' } }),
      right || null
    ] }),
    jsx('div', { className: 'mc-sec-b', children })
  ] })
}

function StackBar({ segments }) {
  const total = segments.reduce((n, s) => n + s.value, 0) || 1
  return jsxs('div', { className: 'mc-chart', children: [
    jsx('div', { className: 'mc-stack', children: segments.filter(s => s.value > 0).map(s =>
      jsx('span', { className: s.cls, style: { width: `${(s.value / total) * 100}%` }, title: `${s.label}: ${s.value}` }, s.label)) }),
    jsx('div', { className: 'mc-legend', children: segments.map(s =>
      jsxs('span', { children: [jsx('i', { className: s.cls }), `${s.label} ${fmtNum(s.value)}`] }, s.label)) })
  ] })
}

function GroupedBars({ rows, series }) {
  if (!rows || !rows.length) return jsx(EmptyState, { title: 'nothing in this window' })
  const max = Math.max(1, rows.reduce((m, r) => Math.max(m, series.reduce((n, s) => Math.max(n, r[s.key] || 0), 0)), 1))
  return jsxs('div', { className: 'mc-chart', children: [
    jsx('div', { className: 'mc-bars', children: rows.map((r, i) =>
      jsx('div', { className: 'mc-bars-col', title: series.map(s => `${s.label} ${r[s.key] || 0}`).join(' · '), children: series.map(s =>
        jsx('span', { className: s.cls, style: { height: `${Math.max(1, ((r[s.key] || 0) / max) * 100)}%` } }, s.key)) }, i)) }),
    jsx('div', { className: 'mc-legend', children: series.map(s =>
      jsxs('span', { children: [jsx('i', { className: s.cls }), s.label] }, s.key)) })
  ] })
}

function Spark({ points }) {
  if (!points || !points.length) return jsx(EmptyState, { title: 'no activity in window' })
  const w = 600, hh = 78
  const max = Math.max(1, points.reduce((m, p) => Math.max(m, p.count), 1))
  const step = points.length > 1 ? w / (points.length - 1) : w
  const line = points.map((p, i) => `${(i * step).toFixed(1)},${(hh - (p.count / max) * (hh - 10) - 5).toFixed(1)}`).join(' ')
  return jsxs('div', { className: 'mc-chart', children: [
    jsx('svg', { className: 'mc-spark', viewBox: `0 0 ${w} ${hh}`, preserveAspectRatio: 'none', children: [
      jsx('polygon', { className: 'mc-spark-area', points: `0,${hh} ${line} ${w},${hh}` }),
      jsx('polyline', { className: 'mc-spark-line', points: line })
    ] }),
    jsx('div', { className: 'mc-row-m', children: `peak ${max} per 10m · ${points.length} buckets` })
  ] })
}

function HBars({ rows }) {
  if (!rows || !rows.length) return jsx(EmptyState, { title: 'nothing to show' })
  const max = Math.max(1, rows.reduce((m, r) => Math.max(m, r.value), 1))
  return jsx('div', { className: 'mc-hbars', children: rows.map((r, i) =>
    jsxs('div', { className: 'mc-hbar', children: [
      jsx('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: r.title || r.label, children: r.label }),
      jsx('div', { className: 'mc-hbar-track', children: jsx('div', { className: r.cls, style: { height: '100%', width: `${Math.max(1, (r.value / max) * 100)}%` } }) }),
      jsx('div', { className: 'mc-hbar-v', children: r.sub ? `${fmtNum(r.value)} ${r.sub}` : fmtNum(r.value) })
    ] }, i)) })
}

// ---------------------------------------------------------------- the ask row (answer in place)

async function postAnswer(item, { choice, optionText, text, unblock }) {
  return rest('/answer', {
    method: 'POST',
    body: { board: item.board, task_id: item.id, choice, option_text: optionText, text, unblock }
  })
}

function AskRow({ item, onDone }) {
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState(item.recommendation || null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)

  async function send(unblock) {
    setBusy(true); setNote(null)
    try {
      const r = await postAnswer(item, { choice, optionText: choice ? item.options[choice - 1] : null, text, unblock })
      setNote(`sent — ${r.status_before} → ${r.status_after}`)
      setText('')
      if (onDone) onDone()
    } catch (e) {
      setNote(`failed: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  return jsxs('div', { className: 'mc-row', children: [
    jsxs('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start' }, children: [
      jsxs('div', { style: { flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: '4px' }, children: [
        jsx('div', { className: 'mc-row-t', children: item.title }),
        jsxs('div', { className: 'mc-row-m', children: [
          jsx(Badge, { children: 'needs you' }),
          jsx('span', { children: `project: ${item.board_title || item.board}` }),
          jsx('span', { children: `asked by ${item.assignee || 'unknown'}` }),
          jsx('span', { children: `parked ${fmtAge(item.age_seconds)}` }),
          (item.hints || []).map(tag => jsx(Badge, { variant: 'outline', children: tag }, tag))
        ] })
      ] }),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => { haptic('tap'); setOpen(!open) }, children: open ? 'hide' : 'open' })
    ] }),
    jsxs('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }, children: [
      jsx(Tip, { label: 'copy this card id', children: jsx(Button, {
        variant: 'ghost', size: 'sm', onClick: () => quiet(() => { void ctx_writeClipboard(item.id); setNote('id copied') }),
        children: item.id
      }) }),
      jsx(Button, {
        variant: 'ghost', size: 'sm', children: 'Copy context',
        onClick: () => quiet(() => { void ctx_writeClipboard(item.briefing || item.id); setNote('context copied') })
      }),
      jsx(Button, {
        variant: 'ghost', size: 'sm', children: 'Chat about it ↗',
        onClick: () => quiet(() => {
          // In-app handoff: copy the briefing, then walk the user to the real chat to paste it.
          void ctx_writeClipboard(item.briefing || item.id)
          host.navigate('/chat')
          setNote('context copied — paste it in the chat')
        })
      })
    ] }),
    item.summary ? jsx('div', { className: 'mc-row-m', children: item.summary }) : null,
    !open && item.ask ? jsx('div', { className: 'mc-ask', children: item.ask.slice(0, 300) + (item.ask.length > 300 ? '…' : '') }) : null,
    open ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' }, children: [
      item.ask ? jsx('div', { className: 'mc-ask', children: item.ask }) : null,
      (item.options || []).map((o, i) => jsxs('button', {
        type: 'button', className: 'mc-opt', 'data-on': choice === i + 1, onClick: () => setChoice(i + 1),
        children: [
          jsx('span', { className: 'mc-opt-n', children: `${i + 1}.` }),
          jsx('span', { style: { flex: '1 1 auto' }, children: o }),
          item.recommendation === i + 1 ? jsx(Badge, { children: 'recommended' }) : null
        ]
      }, i)),
      jsx('textarea', {
        className: 'mc-ask', style: { width: '100%', minHeight: '54px', resize: 'vertical', background: 'transparent', color: 'var(--ui-text-secondary)' },
        placeholder: 'Answer, nuance, or constraints (optional)…', value: text, onChange: e => setText(e.target.value)
      }),
      jsxs('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' }, children: [
        jsx(Button, { size: 'sm', disabled: busy || (choice == null && !text.trim()), onClick: () => void send(true), children: busy ? 'sending…' : 'Answer & re-open card' }),
        jsx(Button, { variant: 'ghost', size: 'sm', disabled: busy || !text.trim(), onClick: () => void send(false), children: 'Comment only (stay parked)' })
      ] })
    ] }) : null,
    note ? jsx('div', { className: 'mc-row-m', children: note }) : null
  ] })
}

// ctx owns the OS, storage and clipboard doors; components deep in the tree use these module-level
// handles so ctx never has to be threaded through props.
let ctx_writeClipboard = () => Promise.resolve(false)
let storage = { get: () => null, set: () => {}, remove: () => {} }

const LAST_SEEN_KEY = 'ui.lastSeenAt'
const ASKS_SEEN_KEY = 'ui.asksSeen'

/** Read the previous visit's timestamp, then advance it — the delta panel is per-visit, not sticky. */
function takeLastSeen() {
  const previous = Number(storage.get(LAST_SEEN_KEY, 0)) || 0
  storage.set(LAST_SEEN_KEY, Date.now())
  return previous
}

/**
 * Notify on NEWLY framed owner asks.
 *
 * `ctx.os.notify` fires only while Hermes is unfocused/backgrounded, so this is a "while you were
 * away" signal rather than an in-app nag, and the app never steals focus (navigation only happens if
 * the notification body is clicked). The first poll only records a baseline, so starting the app
 * never fires a burst for asks that were already waiting.
 */
function startAskWatch(ctx) {
  let stopped = false
  async function tick() {
    if (stopped) {
      return
    }
    try {
      const data = await rest('/waiting')
      const framed = data?.framed || []
      const seen = storage.get(ASKS_SEEN_KEY, null)
      if (Array.isArray(seen)) {
        const fresh = framed.filter(f => !seen.includes(f.id))
        if (fresh.length) {
          const first = fresh[0]
          ctx.os.notify({
            title: fresh.length === 1 ? 'A decision is waiting on you' : `${fresh.length} decisions are waiting on you`,
            body: `${first.board_title || first.board} — ${String(first.title).slice(0, 130)}`,
            activate: WAITING
          })
        }
      }
      storage.set(ASKS_SEEN_KEY, framed.map(f => f.id))
    } catch {
      // backend busy or unreachable this tick — the next one retries
    }
  }
  const timer = setInterval(() => void tick(), 60000)
  ctx.onDispose(() => {
    stopped = true
    clearInterval(timer)
  })
  void tick()
}

/**
 * Dock the waiting list into the main workspace zone as a tab (feature-detected: older builds get a
 * route navigation instead). Chosen over a permanently-registered pane because closing a plugin's
 * ONLY pane disables the whole plugin — an on-demand workspace tab closes harmlessly.
 */
function openWaitingWorkspace() {
  if (typeof host.openWorkspace === 'function') {
    host.openWorkspace('waiting-on-me', {
      title: 'Waiting on me',
      minWidth: '460px',
      render: () => jsx(WaitingWorkspace, {})
    })
    return
  }
  host.navigate(WAITING)
}

function invalidate() {
  void queryClient.invalidateQueries({ queryKey: [ID] })
}

// ---------------------------------------------------------------- the main page

function MissionControlPage() {
  useCss()
  const overview = useRest('/overview', 30000)
  const [q, setQ] = useState('')
  const d = overview.data

  const refresh = () => queryClient.invalidateQueries({ queryKey: [ID] })

  if (overview.isError) {
    return jsx('div', { className: 'mc-page', children: jsx(ErrorState, { title: 'Mission Control backend unreachable', description: String(overview.error?.message || overview.error) }) })
  }
  if (!d) return jsx('div', { className: 'mc-page', children: jsx('div', { className: 'mc-row-m', children: jsx(GlyphSpinner, {}) }) })

  const t = d.totals || {}
  const sched = d.schedules || { failing: [] }
  const match = x => {
    if (!q.trim()) return true
    const s = q.toLowerCase()
    return `${x.title || ''} ${x.assignee || ''} ${x.id || ''}`.toLowerCase().includes(s)
  }
  const framed = (d.awaiting?.framed || []).filter(match)
  const parked = (d.awaiting?.parked || []).filter(match)
  const flight = (d.in_flight || []).filter(match)

  return jsxs('div', { className: 'mc-page', children: [
    jsxs('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }, children: [
      jsx('div', { className: 'mc-sec-t', style: { fontSize: '15px' }, children: 'Mission Control' }),
      jsx('div', { className: 'mc-sec-s', children: `estate-wide · updated ${ago(d.generated_at)}` }),
      jsx('div', { style: { flex: '1 1 auto' } }),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => host.navigate(INSIGHTS), children: 'Insights →' }),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => host.navigate(ESTATE), children: 'Estate →' }),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: refresh, children: 'refresh' })
    ] }),
    jsxs('div', { className: 'mc-tiles', children: [
      jsx(Tile, { k: 'waiting on you', v: fmtNum(t.framed), n: `${fmtNum(t.needs_input)} parked in total`, tone: t.framed > 20 ? 'warn' : undefined }),
      jsx(Tile, { k: 'running now', v: fmtNum(t.running), n: 'bot runs in flight' }),
      jsx(Tile, { k: 'shipped today', v: fmtNum(t.done_today), n: `${fmtNum(t.created_today)} created today` }),
      jsx(Tile, { k: 'capability blocks', v: fmtNum(t.blocked_capability), n: 'not waiting on input' }),
      jsx(Tile, { k: 'schedules failing', v: fmtNum((sched.failing || []).length), n: `${sched.enabled || 0} of ${sched.total || 0} enabled`, tone: (sched.failing || []).length ? 'warn' : undefined })
    ] }),
    jsx(SincePanel, {}),
    jsx(ProjectStrip, {}),
    jsxs('div', { className: 'mc-grid2', children: [
      jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' }, children: [
        jsx(Section, {
          title: 'Waiting on you',
          sub: `${framed.length} ask${framed.length === 1 ? '' : 's'} with options`,
          children: [
            jsx('div', { className: 'mc-row-m', children: 'Your asks have their own page now, so this one stays an overview of everything ELSE that needs action.' }),
            jsx(Button, {
              variant: framed.length ? 'primary' : 'ghost', size: 'sm',
              onClick: () => { haptic('tap'); host.navigate(WAITING_ON_ME) },
              children: framed.length ? `Answer ${framed.length} waiting ask${framed.length === 1 ? '' : 's'} →` : 'Waiting on Me →'
            })
          ]
        }),
        jsx(Section, {
          title: 'In flight',
          sub: `${flight.length} running`,
          children: flight.length ? flight.slice(0, 24).map(r => jsxs('div', { className: 'mc-row', children: [
            jsxs('div', { className: 'mc-row-m', children: [
              jsx('span', { className: 'mc-dot' }),
              jsx('span', { children: r.profile || '—' }),
              jsx('span', { children: `elapsed ${fmtAge(r.elapsed_seconds)}` }),
              jsx('span', { children: `heartbeat ${fmtAge(r.heartbeat_age_seconds)}` }),
              jsx('span', { children: r.board })
            ] }),
            jsx('div', { className: 'mc-row-t', children: r.title }),
            jsx('div', { className: 'mc-row-m', children: r.id })
          ] }, `${r.board}${r.id}`)) : jsx(EmptyState, { title: 'No card is running right now' })
        })
      ] }),
      jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' }, children: [
        jsx(Section, { title: 'Boards', children: (d.boards || []).map(b => jsxs('div', { className: 'mc-row', children: [
          jsx('div', { className: 'mc-row-t', children: `${b.title} (${b.slug})` }),
          jsxs('div', { className: 'mc-row-m', children: [
            jsx('span', { children: `${b.counts?.running || 0} running` }),
            jsx('span', { children: `${b.counts?.blocked || 0} blocked` }),
            jsx('span', { children: `${b.counts?.todo || 0} todo` }),
            jsx('span', { children: `${b.counts?.done || 0} done` })
          ] })
        ] }, b.slug)) }),
        jsx(Section, { title: 'Parked, no framed ask', sub: `${parked.length} shown of ${d.awaiting?.parked_total || 0}`, children: parked.slice(0, 8).map(i => jsxs('div', { className: 'mc-row', children: [
          jsx('div', { className: 'mc-row-t', children: i.title }),
          jsxs('div', { className: 'mc-row-m', children: [
            jsx('span', { children: i.board_title || i.board }),
            jsx('span', { children: i.assignee || '—' }),
            jsx('span', { children: fmtAge(i.age_seconds) })
          ] })
        ] }, `${i.board}${i.id}`)) }),
        jsx(Section, { title: 'Schedule', sub: `${(sched.failing || []).length} failing`, children: (sched.upcoming || []).slice(0, 8).map(j => jsxs('div', { className: 'mc-row', children: [
          jsx('div', { className: 'mc-row-t', children: j.name || j.id }),
          jsxs('div', { className: 'mc-row-m', children: [
            jsx('span', { children: j.profile }),
            jsx('span', { children: j.schedule || '' }),
            jsx('span', { children: j.next_run_at ? ago(j.next_run_at) : '' })
          ] })
        ] }, `${j.profile}${j.id}`)) })
      ] })
    ] })
  ] })
}

// ---------------------------------------------------------------- the insights page

function InsightsPage() {
  useCss()
  const ins = useRest('/insights', 60000)
  const d = ins.data
  if (ins.isError) return jsx('div', { className: 'mc-page', children: jsx(ErrorState, { title: 'Insights backend unreachable', description: String(ins.error?.message || ins.error) }) })
  if (!d) return jsx('div', { className: 'mc-page', children: jsx(GlyphSpinner, {}) })

  const sm = d.status_mix || {}
  const runs = d.runs || {}
  const stuck = d.stuck || { aging: [], oldest: [], total: 0 }
  const sched = d.schedules || { failing: [], upcoming: [] }
  const statusSegs = [
    { label: 'running', value: sm.running || 0, cls: 'mc-c1' },
    { label: 'todo', value: (sm.todo || 0) + (sm.ready || 0), cls: 'mc-c2' },
    { label: 'triage', value: sm.triage || 0, cls: 'mc-c3' },
    { label: 'blocked', value: sm.blocked || 0, cls: 'mc-c1', striped: true },
    { label: 'done', value: sm.done || 0, cls: 'mc-c4' },
    { label: 'archived', value: sm.archived || 0, cls: 'mc-c4' }
  ]
  const agingRows = (stuck.aging || []).map((b, i) => ({
    label: b.label, value: b.count, cls: i < 2 ? 'mc-c3' : 'mc-c1'
  }))
  const kindRows = Object.keys(d.blocked_kinds || {})
    .sort((a, b) => d.blocked_kinds[b] - d.blocked_kinds[a])
    .map(k => ({ label: k, value: d.blocked_kinds[k], cls: k === 'needs_input' ? 'mc-c1' : 'mc-c3' }))
  const peopleRows = Object.keys(runs.running_by_profile || {})
    .sort((a, b) => runs.running_by_profile[b] - runs.running_by_profile[a])
    .map(p => ({ label: p, value: runs.running_by_profile[p], cls: 'mc-c1', sub: `+${(runs.done_24h_by_profile || {})[p] || 0}` }))

  return jsxs('div', { className: 'mc-page', children: [
    jsxs('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' }, children: [
      jsx('div', { className: 'mc-sec-t', style: { fontSize: '15px' }, children: 'Insights' }),
      jsx('div', { className: 'mc-sec-s', children: `window ${d.window_hours}h · updated ${ago(d.generated_at)}` }),
      jsx('div', { style: { flex: '1 1 auto' } }),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => host.navigate(WAITING), children: '← Mission Control' }),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => queryClient.invalidateQueries({ queryKey: [ID] }), children: 'refresh' })
    ] }),
    jsxs('div', { className: 'mc-tiles', children: [
      jsx(Tile, { k: 'running now', v: fmtNum(sm.running || 0), n: 'live runs' }),
      jsx(Tile, { k: 'completed / window', v: fmtNum((d.throughput || []).reduce((n, r) => n + r.completed, 0)), n: `${fmtNum((d.throughput || []).reduce((n, r) => n + r.created, 0))} opened` }),
      jsx(Tile, { k: 'median run', v: fmtAge(runs.duration_median_s), n: `p90 ${fmtAge(runs.duration_p90_s)} · ${fmtNum(runs.measured)} runs` }),
      jsx(Tile, { k: 'median cycle', v: fmtAge(d.cycle?.median_s), n: `p90 ${fmtAge(d.cycle?.p90_s)}` }),
      jsx(Tile, { k: 'stuck', v: fmtNum(stuck.total), n: 'blocked or triage', tone: 'warn' }),
      jsx(Tile, { k: 'waiting on you', v: fmtNum(d.awaiting?.framed || 0), n: `oldest ${fmtAge(d.awaiting?.oldest_seconds)}`, tone: (d.awaiting?.framed || 0) ? 'warn' : undefined })
    ] }),
    jsxs('div', { className: 'mc-grid2', children: [
      jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' }, children: [
        jsx(Section, { title: 'Live pulse', sub: 'non-heartbeat events per 10m, last 2h', children: jsx(Spark, { points: d.spark || [] }) }),
        jsx(Section, { title: 'Throughput', sub: 'per hour — opened, finished, newly blocked', children: jsx(GroupedBars, {
          rows: d.throughput || [],
          series: [ { key: 'created', label: 'opened', cls: 'mc-c2' }, { key: 'completed', label: 'finished', cls: 'mc-c1' }, { key: 'blocked', label: 'blocked', cls: 'mc-c3' } ]
        }) }),
        jsx(Section, { title: 'Stuck work', sub: `${fmtNum(stuck.total)} cards — oldest ${(stuck.oldest || []).length} below`, children: [
          jsx(HBars, { rows: agingRows }),
          jsx(Separator, {}),
          (stuck.oldest || []).map(r => jsxs('div', { className: 'mc-row', children: [
            jsx('div', { className: 'mc-row-t', children: r.title }),
            jsxs('div', { className: 'mc-row-m', children: [
              jsx('span', { children: fmtAge(r.age_seconds) }),
              jsx('span', { children: r.kind }),
              jsx('span', { children: r.assignee || '—' }),
              jsx('span', { children: r.id })
            ] })
          ] }, `${r.board}${r.id}`))
        ] }),
        jsx(Section, { title: 'Failing work', sub: `${(d.failures || []).length} cards`, children: (d.failures || []).length
          ? (d.failures || []).map(f => jsxs('div', { className: 'mc-row', children: [
            jsx('div', { className: 'mc-row-t', children: f.title }),
            jsxs('div', { className: 'mc-row-m', children: [jsx('span', { children: `${f.failures} consecutive` }), jsx('span', { children: f.assignee || '—' }), jsx('span', { children: f.id })] }),
            f.error ? jsx('div', { className: 'mc-ask', children: f.error }) : null
          ] }, `${f.board}${f.id}`))
          : jsx(EmptyState, { title: 'No card is carrying a failure streak' }) })
      ] }),
      jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' }, children: [
        jsx(Section, { title: 'Estate state', sub: 'all boards', children: jsx(StackBar, { segments: statusSegs }) }),
        jsx(Section, { title: 'Why cards are stuck', children: jsx(HBars, { rows: kindRows }) }),
        jsx(Section, { title: 'Who is working', sub: `${fmtNum(runs.started_24h)} started / ${fmtNum(runs.finished_24h)} finished in 24h`, children: jsx(HBars, { rows: peopleRows }) }),
        jsx(AttentionPanel, {}),
        jsx(Section, { title: 'Schedule health', sub: `${sched.enabled || 0} enabled · ${sched.paused || 0} paused`, children: [
          (sched.failing || []).length ? (sched.failing || []).map(j => jsxs('div', { className: 'mc-row', children: [
            jsx('div', { className: 'mc-row-t', children: j.name || j.id }),
            jsxs('div', { className: 'mc-row-m', children: [jsx('span', { children: `streak ${j.failure_streak}` }), jsx('span', { children: j.profile }), jsx('span', { children: j.schedule || '' })] })
          ] }, `${j.profile}${j.id}`)) : jsx(EmptyState, { title: 'every schedule is healthy' }),
          jsx(Separator, {}),
          (sched.upcoming || []).slice(0, 6).map(j => jsxs('div', { className: 'mc-row-m', children: [
            jsx('span', { children: j.next_run_at ? ago(j.next_run_at) : '—' }),
            jsx('span', { children: j.name || j.id }),
            jsx('span', { children: j.profile })
          ] }, `${j.profile}${j.id}`))
        ] })
      ] })
    ] })
  ] })
}

// ---------------------------------------------------------------- the docked workspace tab

function WaitingWorkspace() {
  useCss()
  const w = useRest('/waiting', 30000)
  const d = w.data
  if (w.isError) return jsx('div', { className: 'mc-page', children: jsx(ErrorState, { title: 'Mission Control backend unreachable', description: String(w.error?.message || w.error) }) })
  if (!d) return jsx('div', { className: 'mc-page', children: jsx(GlyphSpinner, {}) })
  const framed = d.framed || []
  return jsxs('div', { className: 'mc-page', children: [
    jsxs('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }, children: [
      jsx('div', { className: 'mc-sec-t', children: 'Waiting on me' }),
      jsx('div', { className: 'mc-sec-s', children: `${framed.length} framed · ${d.totals?.parked || 0} other parks` }),
      jsx('div', { style: { flex: '1 1 auto' } }),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: invalidate, children: 'refresh' })
    ] }),
    framed.length
      ? framed.map(i => jsx(AskRow, { item: i, onDone: invalidate }, `${i.board}${i.id}`))
      : jsx(EmptyState, { title: 'Nothing framed for you right now' })
  ] })
}

// ---------------------------------------------------------------- since you last looked

function SincePanel() {
  const [delta, setDelta] = useState(null)
  useEffect(() => {
    const previous = takeLastSeen()
    if (!previous) {
      return
    }
    let alive = true
    rest(`/since?ts=${previous}`)
      .then(d => { if (alive) setDelta(d) })
      .catch(() => { /* the panel is a nicety; never block the page on it */ })
    return () => { alive = false }
  }, [])
  if (!delta) return null
  const c = delta.counts || {}
  if (!c.opened && !c.finished && !c.parked) return null
  const parked = (delta.parked || []).slice(0, 6)
  return jsx(Section, {
    title: 'Since you last looked',
    sub: delta.since ? `since ${ago(delta.since)}` : undefined,
    children: [
      jsxs('div', { className: 'mc-row-m', children: [
        jsx('span', { children: `${c.parked} newly parked on you` }),
        jsx('span', { children: `${c.opened} cards opened` }),
        jsx('span', { children: `${c.finished} cards finished` })
      ] }),
      parked.length
        ? parked.map(p => jsxs('div', { className: 'mc-row', children: [
            jsx('div', { className: 'mc-row-t', children: p.title }),
            jsxs('div', { className: 'mc-row-m', children: [
              jsx('span', { children: p.board_title || p.board }),
              jsx('span', { children: p.assignee || '—' }),
              jsx('span', { children: p.id })
            ] })
          ] }, `${p.board}${p.id}`))
        : jsx('div', { className: 'mc-row-m', children: 'nothing was newly parked on you' })
    ]
  })
}

// ---------------------------------------------------------------- the estate: one row per bot

function EstatePage() {
  useCss()
  const est = useRest('/estate', 60000)
  const d = est.data
  if (est.isError) return jsx('div', { className: 'mc-page', children: jsx(ErrorState, { title: 'Estate backend unreachable', description: String(est.error?.message || est.error) }) })
  if (!d) return jsx('div', { className: 'mc-page', children: jsx(GlyphSpinner, {}) })

  const t = d.totals || {}
  const all = d.profiles || []
  const idle = all.filter(p => !p.jobs && !p.running && !p.open && !p.blocked)

  // Group by the domain tag each bot carries in its profile description — that is what makes a
  // 63-bot estate legible: you scan "FINANCE / TOS ENGINEERING / PLATFORM OPS", not 63 names.
  const byDomain = new Map()
  for (const p of all) {
    const key = p.domain || 'unlabelled'
    if (!byDomain.has(key)) byDomain.set(key, [])
    byDomain.get(key).push(p)
  }
  const weight = list => list.reduce((n, p) => n + p.jobs_failing * 1000 + p.asks * 10 + p.running + p.blocked, 0)
  const groups = [...byDomain.entries()]
    .map(([domain, list]) => ({
      domain,
      list: [...list].sort((a, b) => weight([b]) - weight([a])),
      failing: list.reduce((n, p) => n + p.jobs_failing, 0),
      asks: list.reduce((n, p) => n + p.asks, 0),
      running: list.reduce((n, p) => n + p.running, 0),
      active: list.filter(p => p.jobs || p.running || p.open || p.blocked).length
    }))
    .sort((a, b) => weight(b.list) - weight(a.list))

  const botRow = p => jsxs('div', { className: 'mc-row', children: [
    jsxs('div', { className: 'mc-row-m', children: [
      jsx('span', { children: p.profile }),
      !p.jobs && !p.running && !p.open && !p.blocked ? jsx(Badge, { variant: 'outline', children: 'idle' }) : null,
      p.jobs ? jsx('span', { children: `${p.jobs_enabled}/${p.jobs} jobs` }) : null,
      p.jobs_failing ? jsx(Badge, { variant: 'outline', children: `${p.jobs_failing} failing` }) : null,
      p.last_status ? jsx('span', { children: `last: ${p.last_status}` }) : null,
      p.next_run_at ? jsx('span', { children: `next ${ago(p.next_run_at)}` }) : null
    ] }),
    p.purpose ? jsx('div', { className: 'mc-ask', children: p.purpose.slice(0, 260) }) : null,
    jsxs('div', { className: 'mc-row-m', children: [
      jsx('span', { children: `${p.running} running` }),
      jsx('span', { children: `${p.open} open` }),
      jsx('span', { children: `${p.blocked} blocked` }),
      jsx('span', { children: `${p.asks} needing input` }),
      jsx('span', { children: `${p.done_window} done in window` })
    ] }),
    p.last_error ? jsx('div', { className: 'mc-ask', children: String(p.last_error).slice(0, 220) }) : null
  ] }, p.profile)

  return jsxs('div', { className: 'mc-page', children: [
    jsxs('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }, children: [
      jsx('div', { className: 'mc-sec-t', style: { fontSize: '15px' }, children: 'Estate' }),
      jsx('div', { className: 'mc-sec-s', children: `every bot · window ${d.window_hours}h · updated ${ago(d.generated_at)}` }),
      jsx('div', { style: { flex: '1 1 auto' } }),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => host.navigate(WAITING), children: '← Mission Control' }),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: invalidate, children: 'refresh' })
    ] }),
    jsxs('div', { className: 'mc-tiles', children: [
      jsx(Tile, { k: 'profiles', v: fmtNum(t.profiles), n: `${fmtNum(t.with_schedule)} with a schedule` }),
      jsx(Tile, { k: 'schedules failing', v: fmtNum(t.failing), n: 'bots with a red job', tone: t.failing ? 'warn' : undefined }),
      jsx(Tile, { k: 'running', v: fmtNum(t.running), n: 'live card runs' }),
      jsx(Tile, { k: 'needing input', v: fmtNum(t.asks), n: 'cards parked on a human' }),
      jsx(Tile, { k: 'blocked', v: fmtNum(t.blocked), n: 'blocked across the estate' }),
      jsx(Tile, { k: 'idle', v: fmtNum(idle.length), n: 'profiles with nothing on their plate' })
    ] }),
    jsx(Section, { title: 'Every bot, by domain', sub: `${groups.length} domains · ${all.length} profiles`, children: jsx('div', { className: 'mc-row-m', children: 'grouped by the domain in each bot\u2019s own profile description; busiest and most broken first' }) }),
    jsx(UnownedPanel, { profiles: all }),
    groups.map(gr => jsx(Section, {
      title: gr.domain,
      sub: `${gr.list.length} bots · ${gr.active} active · ${gr.running} running · ${gr.asks} needing input${gr.failing ? ` · ${gr.failing} failing` : ''}`,
      children: gr.list.map(botRow)
    }, gr.domain)),
    jsx(Section, { title: 'Idle', sub: `${idle.length} profiles — nothing scheduled, nothing assigned`, children: jsx('div', { className: 'mc-row-m', children: idle.map(p => jsx('span', { children: p.profile }, p.profile)) }) })
  ] })
}

// ---------------------------------------------------------------- ::mc-card{id="…"} in a message

function CardDirective({ attrs }) {
  useCss()
  const id = typeof attrs?.id === 'string' ? attrs.id.trim() : ''
  const valid = /^t_[0-9a-z]{4,}$/i.test(id)
  const q = useQuery({
    queryKey: [ID, 'directive-card', id],
    queryFn: () => rest(`/card_any?card_id=${encodeURIComponent(id)}`),
    enabled: valid,
    retry: 0,
    staleTime: 15000
  })
  if (!valid) {
    return jsx('div', { className: 'mc-row-m', children: 'Mission Control: ::mc-card needs a card id — e.g. ::mc-card{id="t_1b1e089a"}' })
  }
  if (q.isError) {
    return jsx('div', { className: 'mc-row-m', children: `Mission Control: card ${id} not found on any board` })
  }
  if (!q.data) {
    return jsxs('div', { className: 'mc-row-m', children: [jsx(GlyphSpinner, {}), ` loading ${id}…`] })
  }
  const d = q.data
  const t = d.task || {}
  if (d.frame?.framed) {
    // an owner ask rendered inline: pick an option in the message itself
    return jsx(AskRow, {
      item: {
        board: d.board, board_title: d.board_title, id: t.id, title: t.title, assignee: t.assignee,
        status: t.status, ask: d.ask, options: d.frame.options, recommendation: d.frame.recommendation,
        briefing: d.briefing, framed: true, hints: d.hints || [],
        comments: (d.comments || []).length, age_seconds: null
      },
      onDone: invalidate
    })
  }
  return jsxs('div', { className: 'mc-row', children: [
    jsx('div', { className: 'mc-row-t', children: t.title }),
    jsxs('div', { className: 'mc-row-m', children: [
      jsx(Badge, { children: t.status }),
      jsx('span', { children: d.board_title || d.board }),
      jsx('span', { children: t.assignee || '—' }),
      jsx('span', { children: t.id })
    ] }),
    d.ask ? jsx('div', { className: 'mc-ask', children: d.ask }) : null
  ] })
}

// ---------------------------------------------------------------- your attention (ask pipeline)

function AttentionPanel() {
  const att = useRest('/attention?days=7', 120000)
  const d = att.data
  if (att.isError) return jsx(Section, { title: 'Your attention', children: jsx(ErrorState, { title: 'attention data unavailable' }) })
  if (!d) return jsx(Section, { title: 'Your attention', children: jsx(GlyphSpinner, {}) })
  const lanes = (d.lanes || []).slice(0, 8)
  return jsx(Section, {
    title: 'Your attention',
    sub: `last ${d.window_days} days · asks filed, and what happened next`,
    children: [
      jsxs('div', { className: 'mc-row-m', children: [
        jsx('span', { children: `${d.filed} asks filed` }),
        jsx('span', { children: `${d.answered} re-opened after parking` }),
        jsx('span', { children: `${d.owner_answers} owner comments (${(d.owner_authors || ['jesse']).join(' / ')})` }),
        jsx('span', { children: `you answered ${d.owner_answered} of them (${d.owner_answer_rate == null ? '—' : Math.round(d.owner_answer_rate * 100) + '%'}) · median ${fmtAge(d.owner_median_wait_s)}` }),
        jsx('span', { children: `median wait ${fmtAge(d.median_wait_s)} · p90 ${fmtAge(d.p90_wait_s)}` }),
        jsx('span', { children: `${d.still_open} still open · oldest ${fmtAge(d.oldest_open_s)}` })
      ] }),
      jsx('div', { className: 'mc-row-m', children: 'Read the two columns separately: a card re-opened without a comment from you was usually resolved by its own lane (superseded, re-typed, or handed on), not answered by you. An owner comment is one authored ' + ((d.owner_authors || ['jesse']).join(', ')) + ' — Mission Control\'s answer button, the verbatim chat recorder, and the hand-recorded path; a lane re-opening its own card is not counted. Mission Control answers only exist from 2026-09-17 ~02:00Z, so a window starting earlier reports a floor.' }),
      lanes.length
        ? jsx(HBars, { rows: lanes.map(l => ({ label: l.lane, value: l.filed, cls: 'mc-c2', sub: `→ ${l.answered}` })) })
        : jsx(EmptyState, { title: 'no asks in this window' }),
      lanes.length
        ? jsxs('div', { className: 'mc-row-m', children: ['median wait: '].concat(lanes.map(l => jsx('span', { children: `${l.lane} ${fmtAge(l.median_s)}` }, l.lane))) })
        : null,
      lanes.length
        ? jsxs('div', { className: 'mc-row-m', children: ['answered by you, per lane: '].concat(lanes.map(l => jsx('span', { children: `${l.lane} ${l.owner_answered ? `${l.owner_answered} (${fmtAge(l.owner_median_s)})` : '0'}` }, l.lane))) })
        : null
    ]
  })
}

// ---------------------------------------------------------------- needs an owner (with one-click assign)

function UnownedPanel({ profiles }) {
  useCss()
  const u = useRest('/unowned', 60000)
  const [pick, setPick] = useState({})
  const [busy, setBusy] = useState(null)
  const [note, setNote] = useState(null)
  const d = u.data
  if (u.isError) return jsx(Section, { title: 'Needs an owner', children: jsx(ErrorState, { title: 'unowned data unavailable' }) })
  if (!d) return jsx(Section, { title: 'Needs an owner', children: jsx(GlyphSpinner, {}) })
  if (!d.total) {
    return jsx(Section, {
      title: 'Needs an owner',
      sub: 'every open card has one',
      children: jsx('div', { className: 'mc-row-m', children: 'Nothing is unowned right now: every card in todo/ready/triage/blocked names a lane that exists.' })
    })
  }
  const names = (profiles || []).map(p => p.profile).filter(Boolean).sort()

  async function submit(item) {
    const who = pick[item.id]
    if (!who) {
      setNote('pick a profile first')
      return
    }
    setBusy(item.id)
    setNote(null)
    try {
      await rest('/assign', { method: 'POST', body: { board: item.board, task_id: item.id, assignee: who } })
      setNote(`${item.id} is now owned by ${who}`)
      invalidate()
    } catch (e) {
      setNote(`assign failed: ${e.message}`)
    } finally {
      setBusy(null)
    }
  }

  return jsx(Section, {
    title: 'Needs an owner',
    sub: `${d.total} card${d.total === 1 ? '' : 's'} with no real lane, oldest first`,
    children: [
      d.items.slice(0, 12).map(item => jsxs('div', { className: 'mc-row', children: [
        jsx('div', { className: 'mc-row-t', children: item.title }),
        jsxs('div', { className: 'mc-row-m', children: [
          jsx(Badge, { children: item.status }),
          jsx('span', { children: item.board_title || item.board }),
          jsx('span', { children: `waiting ${fmtAge(item.age_seconds)}` }),
          jsx('span', { children: item.reason || (item.assignee ? `owner ${item.assignee} is not a lane` : 'no assignee') }),
          jsx('span', { children: item.id })
        ] }),
        jsxs('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }, children: [
          jsx('select', {
            value: pick[item.id] || '',
            onChange: e => setPick({ ...pick, [item.id]: e.target.value }),
            style: {
              background: 'transparent', color: 'var(--ui-text-secondary)', fontSize: '11px',
              border: '1px solid var(--ui-stroke-secondary)', borderRadius: '5px', padding: '2px 6px'
            },
            children: [jsx('option', { value: '', children: 'assign to…' }, 'none')]
              .concat(names.map(n => jsx('option', { value: n, children: n }, n)))
          }),
          jsx(Button, { size: 'sm', disabled: busy === item.id, onClick: () => void submit(item), children: busy === item.id ? 'assigning…' : 'Assign' })
        ] })
      ] }, item.id)),
      d.total > 12 ? jsx('div', { className: 'mc-row-m', children: `${d.total - 12} more not shown — open the board to see the rest` }) : null,
      note ? jsx('div', { className: 'mc-row-m', children: note }) : null
    ]
  })
}


// ---------------------------------------------------------------- Waiting on Me (its own page)

function WaitingOnMePage() {
  useCss()
  const w = useRest('/waiting', 45000)
  const [q, setQ] = useState('')
  const d = w.data
  if (w.isError) return jsxs('div', { className: 'mc-page', children: [
    jsx(ErrorState, { title: 'Waiting on Me is unreachable', hint: 'the backend answered an error — check the dashboard service' }) ] })
  if (!d) return jsxs('div', { className: 'mc-page', children: jsx(GlyphSpinner, {}) })
  const t = d.totals || {}
  const match = x => {
    if (!q.trim()) return true
    const s = q.toLowerCase()
    return `${x.title || ''} ${x.assignee || ''} ${x.id || ''} ${x.ask || ''} ${x.board_title || ''}`.toLowerCase().includes(s)
  }
  const framed = (d.framed || []).filter(match)
  const parked = (d.parked || []).filter(match)
  return jsxs('div', { className: 'mc-page', children: [
    jsxs('div', { className: 'mc-head', children: [
      jsx('div', { className: 'mc-sec-t', style: { fontSize: '15px' }, children: 'Waiting on Me' }),
      jsx('div', { className: 'mc-sec-s', children: `only what needs a decision from you · updated ${ago(d.generated_at)}` }),
      jsx('div', { style: { flex: '1 1 auto' } }),
      jsx('input', {
        className: 'mc-search', placeholder: 'filter…', value: q, onChange: e => setQ(e.target.value)
      }),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => invalidate(), children: 'refresh' })
    ] }),
    jsxs('div', { className: 'mc-tiles', children: [
      jsx(Tile, { k: 'asks with options', v: fmtNum(t.framed ?? framed.length), n: `oldest ${fmtAge(d.oldest_seconds)}`, tone: (t.framed || framed.length) ? 'warn' : undefined }),
      jsx(Tile, { k: 'parked, no ask', v: fmtNum(t.parked ?? parked.length), n: 'held by a bot, nothing for you to decide' }),
      jsx(Tile, { k: 'needs_input total', v: fmtNum(t.needs_input), n: 'includes internal flips' })
    ] }),
    framed.length
      ? jsx(Section, {
          title: 'Answer in place',
          sub: `${framed.length} ask${framed.length === 1 ? '' : 's'} with options · pick one, or use the recommendation`,
          children: framed.map(i => jsx(AskRow, { item: i, onDone: () => invalidate() }, `${i.board}${i.id}`))
        })
      : jsx(Section, { title: 'Nothing is waiting on you', children: jsx(EmptyState, { title: 'clear board', hint: 'asks show up here the moment a bot frames options for you' }) }),
    parked.length
      ? jsx(Section, {
          title: 'Parked, nothing to decide',
          sub: `${parked.length} shown`,
          children: parked.slice(0, 12).map(i => jsxs('div', { className: 'mc-row', children: [
            jsx('div', { className: 'mc-row-t', children: i.title }),
            jsxs('div', { className: 'mc-row-m', children: [
              jsx(Badge, { children: i.status }),
              jsx('span', { children: i.board_title || i.board }),
              jsx('span', { children: i.id }),
              jsx('span', { children: `parked ${fmtAge(i.age_seconds)}` })
            ] })
          ] }, `${i.board}${i.id}`))
        })
      : null
  ] })
}

// ---------------------------------------------------------------- Projects (the owner-facing layer)

function ProjectStrip() {
  const p = useRest('/projects', 120000)
  const rows = ((p.data || {}).projects || []).filter(r => r.status !== 'archived')
  if (!rows.length) return null
  return jsx(Section, {
    title: 'Active projects',
    sub: `${rows.length} · ${rows.filter(r => r.status === 'active').length} active`,
    children: [
      ...rows.map(r => jsxs('div', {
        className: 'mc-row mc-row-click',
        onClick: () => { haptic('tap'); host.navigate(PROJECTS) },
        children: [
          jsx('div', { className: 'mc-row-t', children: r.name }),
          jsxs('div', { className: 'mc-row-m', children: [
            jsx(Badge, { children: r.status }),
            jsx('span', { children: `${fmtNum(r.open)} open` }),
            jsx('span', { children: `${fmtNum(r.blocked)} blocked` }),
            jsx('span', { children: `${fmtNum(r.asks)} waiting on you` }),
            jsx('span', { children: `${r.bots.length} bots` }),
            r.failing ? jsx(Badge, { variant: 'outline', children: `${r.failing} failing` }) : null
          ] })
        ]
      }, r.key)),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => host.navigate(PROJECTS), children: 'Manage projects →' })
    ]
  })
}

function ProjectsPage() {
  useCss()
  const p = useRest('/projects', 60000)
  const est = useRest('/estate', 300000)
  // The same funnel data, so the project dashboard can name each project's constraint
  // without the owner opening the Flow page.
  const fl = useRest('/flow', 60000)
  const flowByKey = {}
  ;((fl.data || {}).projects || []).forEach(x => { flowByKey[x.key] = x })
  const [busy, setBusy] = useState(null)
  const [note, setNote] = useState(null)
  const d = p.data
  if (p.isError) return jsxs('div', { className: 'mc-page', children: [
    jsx(ErrorState, { title: 'Projects are unreachable' }) ] })
  if (!d) return jsxs('div', { className: 'mc-page', children: jsx(GlyphSpinner, {}) })
  const names = (((est.data || {}).profiles) || []).map(x => x.profile).filter(Boolean).sort()

  async function setStatus(pr, status, pauseBots) {
    setBusy(pr.key); setNote(null)
    try {
      const r = status === 'archived'
        ? await rest('/projects/archive', { method: 'POST', body: { key: pr.key, archived: true, pause_bots: !!pauseBots } })
        : await rest('/projects/save', { method: 'POST', body: { key: pr.key, status } })
      const parked = (r.cron || []).filter(c => c.changed).map(c => `${c.profile}(${c.changed})`).join(' ')
      setNote(`${pr.name} → ${r.status}${parked ? ` · parked jobs: ${parked}` : ''}`)
      invalidate()
    } catch (e) {
      setNote(`${pr.name}: ${e.message}`)
    } finally { setBusy(null) }
  }

  async function linkBot(pr, bot, add) {
    const next = add ? (pr.bots_explicit || []).concat([bot]) : (pr.bots_explicit || []).filter(b => b !== bot)
    setBusy(pr.key); setNote(null)
    try {
      await rest('/projects/save', { method: 'POST', body: { key: pr.key, bots: next } })
      setNote(`${pr.name}: ${add ? 'linked' : 'unlinked'} ${bot}`)
      invalidate()
    } catch (e) {
      setNote(`${pr.name}: ${e.message}`)
    } finally { setBusy(null) }
  }

  return jsxs('div', { className: 'mc-page', children: [
    jsxs('div', { className: 'mc-head', children: [
      jsx('div', { className: 'mc-sec-t', style: { fontSize: '15px' }, children: 'Projects' }),
      jsx('div', { className: 'mc-sec-s', children: `${d.projects.length} project${d.projects.length === 1 ? '' : 's'} · from projects.db, merged across profiles by slug` }),
      jsx('div', { style: { flex: '1 1 auto' } }),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => { haptic('tap'); host.navigate(FLOW) }, children: 'Flow →' }),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => invalidate(), children: 'refresh' })
    ] }),
    ...d.projects.map(pr => jsxs('div', { className: 'mc-card', children: [
      jsxs('div', { className: 'mc-card-h', children: [
        jsx(Badge, { children: pr.status }),
        jsx('span', { className: 'mc-card-t-inline', children: pr.name }),
        pr.board ? jsx('span', { className: 'mc-mono', children: `board ${pr.board}` }) : null,
        jsx('span', { className: 'mc-dim', children: `${(pr.homes || []).join(', ')} · ${pr.ids.length} project id(s)` })
      ] }),
      jsxs('div', { className: 'mc-tiles mc-tiles-sm', children: [
        jsx(Tile, { k: 'open', v: fmtNum(pr.open), n: `${fmtNum(pr.cards.running || 0)} running` }),
        jsx(Tile, { k: 'blocked', v: fmtNum(pr.blocked), tone: pr.blocked ? 'warn' : undefined, n: 'incl. triage' }),
        jsx(Tile, { k: 'waiting on you', v: fmtNum(pr.asks), tone: pr.asks ? 'warn' : undefined, n: 'asks on this board' }),
        jsx(Tile, { k: 'bots', v: fmtNum(pr.bots.length), n: pr.failing ? `${pr.failing} with a failing job` : 'no failing jobs' })
      ] }),
      (function () {
        const f = flowByKey[pr.key]
        const c = f && (f.stages || []).find(s => s.constraint)
        if (!c || !c.wip) return null
        return jsxs('div', { className: 'mc-row-m', children: [
          jsx('span', { className: 'mc-chip mc-chip-hot', children: `constraint · ${c.label}` }),
          jsx('span', { children: `${fmtNum(c.wip)} waiting` }),
          jsx('span', { children: `${fmtNum(c.queue_hours)} queue-hours` }),
          c.wait_h != null ? jsx('span', { children: `~${fmtNum(c.wait_h)}h to clear` }) : null,
          jsx('a', { className: 'mc-link', onClick: () => { haptic('tap'); host.navigate(FLOW) }, children: 'see the flow' })
        ] })
      })(),
      pr.description ? jsx('div', { className: 'mc-dim', children: pr.description }) : null,
      jsxs('div', { className: 'mc-chips', children: [
        ...pr.bots.map(b => jsxs('span', { className: 'mc-chip', children: [
          jsx('span', { children: b }),
          (pr.bots_explicit || []).includes(b)
            ? jsx('button', { className: 'mc-chip-x', title: 'unlink', onClick: () => void linkBot(pr, b, false), children: '✕' })
            : null
        ] }, b)),
        jsxs('select', {
          className: 'mc-select', value: '',
          onChange: e => { if (e.target.value) void linkBot(pr, e.target.value, true) },
          children: [jsx('option', { value: '', children: 'link a bot…' }, 'none')]
            .concat(names.map(n => jsx('option', { value: n, children: n }, n)))
        })
      ] }),
      jsxs('div', { className: 'mc-ask-foot', children: [
        jsx(Button, { size: 'sm', disabled: busy === pr.key || pr.status === 'active', onClick: () => void setStatus(pr, 'active'), children: 'Active' }),
        jsx(Button, { size: 'sm', disabled: busy === pr.key || pr.status === 'paused', onClick: () => void setStatus(pr, 'paused'), children: 'Pause' }),
        jsx(Button, { size: 'sm', disabled: busy === pr.key || pr.status === 'archived', onClick: () => void setStatus(pr, 'archived'), children: 'Archive' }),
        jsx(Button, { size: 'sm', variant: 'ghost', disabled: busy === pr.key, onClick: () => void setStatus(pr, 'archived', true), children: 'Archive + park its bots' }),
        note ? jsx('span', { className: 'mc-note', children: note }) : null
      ] })
    ] }, pr.key)),
    jsx(Section, {
      title: 'How this relates to the app’s own Projects',
      children: jsx('div', { className: 'mc-row-m', children: 'Projects come from projects.db — the same store the app’s Projects screen writes — merged across profiles by slug, because each profile keeps its own copy of the ids. Status, linked bots and notes are Mission Control’s layer (state/mc-projects.json); the bot list is also derived from whoever is actually holding the project’s cards.' })
    }),
    d.orphan_project_ids && d.orphan_project_ids.length
      ? jsx(Section, { title: 'Project ids with no project record', sub: `${d.orphan_project_ids.length}`, children: jsx('div', { className: 'mc-mono', children: d.orphan_project_ids.join(', ') }) })
      : null
  ] })
}

// ---------------------------------------------------------------- Flow (the living value stream)
//
// A left-to-right funnel: one band per stage, band THICKNESS = how many cards are sitting in
// that stage right now, so a stage with no load is a hairline and the widest band is where the
// work has piled up. The named constraint is outlined; rework is drawn as a dashed return arc
// under the spine; every stage carries a verdict so "flowing", "slowing", "backed up" and
// "idle" read at a glance instead of being arithmetic in the reader's head.
//
// Everything is data-driven from /flow — stage ids, labels and counts all come from the payload,
// so a stage added on the backend appears here without a UI change.

const FLOW_TONE = {
  ok: { chip: 'mc-chip mc-chip-ok', fill: 'mc-flow-band-ok' },
  warn: { chip: 'mc-chip mc-chip-warn', fill: 'mc-flow-band-warn' },
  hot: { chip: 'mc-chip mc-chip-hot', fill: 'mc-flow-band-hot' },
  dim: { chip: 'mc-chip mc-chip-dim', fill: 'mc-flow-band-idle' }
}

function stageVerdict(s) {
  if (!s.wip) return { key: 'idle', tone: 'dim', label: 'idle — no load' }
  if (s.flow === 'n/a') return { key: 'count', tone: 'ok', label: 'count' }
  if (s.constraint) return { key: 'constraint', tone: 'hot', label: 'CONSTRAINT' }
  if (s.flow === 'unmeasured') return { key: 'queue', tone: 'warn', label: 'queue · exit not instrumented' }
  if (s.wait_h == null) return { key: 'queue', tone: 'warn', label: 'no measured exit' }
  if (s.wait_h <= 2) return { key: 'flowing', tone: 'ok', label: 'flowing' }
  if (s.wait_h <= 12) return { key: 'slowing', tone: 'warn', label: 'slowing' }
  return { key: 'backed', tone: 'hot', label: 'backed up' }
}

function stageLine(s) {
  const bits = []
  if (s.wip) bits.push(`${fmtNum(s.wip)} here`)
  if (s.median_age_h != null) bits.push(`median ${s.median_age_h}h`)
  if (s.oldest_age_h != null && s.oldest_age_h !== s.median_age_h) bits.push(`oldest ${s.oldest_age_h}h`)
  if (s.flow === 'unmeasured') bits.push('flow not instrumented')
  else if (s.flow !== 'n/a') bits.push(`${fmtNum(s.out)} out / ${s.window_hours || 168}h`)
  if (s.wait_h != null && s.wip) bits.push(`~${fmtNum(s.wait_h)}h to clear`)
  return bits.join(' · ')
}

/** The pipe: bands sized by WIP, links between them, rework arcs under the spine. */
function FlowPipe({ stages, edges, height, ariaLabel }) {
  const rows = (stages || []).filter(s => !s.terminal)
  if (!rows.length) return jsx(EmptyState, { title: 'nothing in the flow' })
  const W = 1000
  const H = height || 200
  const cy = H * 0.4
  const maxWip = Math.max(1, ...rows.map(s => s.wip || 0))
  const h = v => (v ? Math.max(3, (v / maxWip) * (H * 0.28)) : 1.5)
  const slot = W / rows.length
  const pad = Math.min(20, slot * 0.18)
  const left = i => i * slot + pad
  const right = i => (i + 1) * slot - pad
  const centre = i => (left(i) + right(i)) / 2
  const index = {}
  rows.forEach((s, i) => { index[s.id] = i })

  const children = []
  for (let i = 0; i < rows.length - 1; i++) {
    const a = h(rows[i].wip)
    const b = h(rows[i + 1].wip)
    const idle = !rows[i].wip && !rows[i + 1].wip
    children.push(jsx('polygon', {
      className: 'mc-flow-link',
      'data-idle': idle ? 'true' : undefined,
      points: [
        `${right(i).toFixed(1)},${(cy - a / 2).toFixed(1)}`,
        `${left(i + 1).toFixed(1)},${(cy - b / 2).toFixed(1)}`,
        `${left(i + 1).toFixed(1)},${(cy + b / 2).toFixed(1)}`,
        `${right(i).toFixed(1)},${(cy + a / 2).toFixed(1)}`
      ].join(' ')
    }, `link-${i}`))
  }
  rows.forEach((s, i) => {
    const bh = h(s.wip)
    children.push(jsx('rect', {
      className: 'mc-flow-band ' + FLOW_TONE[stageVerdict(s).tone].fill,
      'data-hot': s.constraint ? 'true' : undefined,
      x: left(i).toFixed(1),
      y: (cy - bh / 2).toFixed(1),
      width: Math.max(2, right(i) - left(i)).toFixed(1),
      height: bh.toFixed(1),
      rx: 3
    }, `band-${s.id}`))
  })
  rows.forEach((s, i) => {
    children.push(jsx('text', {
      className: 'mc-flow-num', textAnchor: 'middle',
      x: centre(i).toFixed(1), y: (cy - H * 0.3).toFixed(1), children: fmtNum(s.wip)
    }, `num-${s.id}`))
    children.push(jsx('text', {
      className: 'mc-flow-lbl', textAnchor: 'middle',
      x: centre(i).toFixed(1), y: (H * 0.84).toFixed(1), children: s.label
    }, `lbl-${s.id}`))
  })

  // Rework: the biggest two backward edges, drawn as return arcs so the picture
  // shows work being redone rather than hiding it in a number.
  const back = (edges || [])
    .filter(e => e.direction === 'rework' && index[e.from] != null && index[e.to] != null)
    .sort((a, b) => b.count - a.count)
    .slice(0, 2)
  back.forEach((e, k) => {
    const a = index[e.from]
    const b = index[e.to]
    const y = H * (0.62 + k * 0.08)
    children.push(jsx('path', {
      className: 'mc-flow-rework',
      d: `M ${centre(a).toFixed(1)},${(cy + h(rows[a].wip) / 2).toFixed(1)} C ${centre(a).toFixed(1)},${y.toFixed(1)} ` +
         `${centre(b).toFixed(1)},${y.toFixed(1)} ${centre(b).toFixed(1)},${(cy + h(rows[b].wip) / 2).toFixed(1)}`
    }, `rw-${e.from}-${e.to}`))
    children.push(jsx('text', {
      className: 'mc-flow-lbl', textAnchor: 'middle',
      x: ((centre(a) + centre(b)) / 2).toFixed(1), y: (y + 3).toFixed(1),
      children: `rework ${fmtNum(e.count)}`
    }, `rwl-${e.from}-${e.to}`))
  })

  return jsx('svg', {
    className: 'mc-flow-svg',
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': ariaLabel || 'value stream',
    // NOTE: children belongs IN props. Passing it as jsx()'s third argument makes it the KEY,
    // which renders an empty <svg> — caught by the headless render check, invisible to
    // `node --check`.
    children
  })
}

function StageTable({ stages }) {
  const rows = (stages || []).filter(s => !s.terminal)
  return jsx('div', { className: 'mc-flow-stages', children: rows.map(s => {
    const v = stageVerdict(s)
    return jsxs('div', { className: 'mc-flow-stage', 'data-tone': v.tone, children: [
      jsxs('div', { className: 'mc-flow-stage-h', children: [
        jsx('span', { className: 'mc-flow-stage-t', children: s.label }),
        jsx('span', { className: FLOW_TONE[v.tone].chip, children: v.label })
      ] }),
      jsx('div', { className: 'mc-flow-stage-v', children: fmtNum(s.wip) }),
      jsx('div', { className: 'mc-flow-stage-m', children: stageLine(s) })
    ] }, s.id)
  }) })
}

/** The code leg, mapped into the same shape so it draws with the same pipe. */
function pipelineStages(pl) {
  if (!pl || !pl.measured) return []
  const b = pl.pr_buckets || {}
  const dp = pl.deploy || {}
  const mk = (id, label, wip, extra) => Object.assign({
    id, label, wip: wip || 0, terminal: false, flow: 'n/a'
  }, extra || {})
  return [
    mk('pr_open', 'PRs open', pl.prs_open, { median_age_h: pl.pr_age_median_h, oldest_age_h: pl.pr_age_oldest_h }),
    mk('ci_run', 'CI running', b.ci_running),
    mk('ci_fail', 'CI failing', b.ci_failing),
    mk('conflict', 'Conflicts', b.conflicts),
    mk('review', 'Awaiting review', b.awaiting_review),
    mk('mergeable', 'Ready to merge', b.mergeable),
    mk('merged', 'Merged 7d', pl.prs_merged_7d),
    mk('deploy', 'Deploys running', dp.in_progress)
  ]
}

function PipelineLeg({ pl, repo }) {
  if (!repo) {
    return jsx('div', { className: 'mc-dim', children: 'No git remote resolved for this project, so there is no PR/CI/deploy leg to measure.' })
  }
  if (!pl) return jsx('div', { className: 'mc-dim', children: 'reading the code pipeline…' })
  if (pl.error) return jsx('div', { className: 'mc-note', children: `code pipeline unavailable: ${pl.error}` })
  if (!pl.measured) {
    return jsxs('div', { className: 'mc-dim', children: [
      'reading GitHub for ', jsx('span', { className: 'mc-mono', children: repo }),
      '… the first read takes a few seconds and this panel never blocks on it.'
    ] })
  }
  const stages = pipelineStages(pl)
  const dp = pl.deploy || {}
  const ci = pl.ci || {}
  return jsxs('div', { className: 'mc-flow', children: [
    jsx(FlowPipe, { stages, height: 150, ariaLabel: `${repo} PR and CI pipeline` }),
    jsxs('div', { className: 'mc-row-m', children: [
      jsx('span', { className: 'mc-mono', children: repo }),
      jsx('span', { children: `${fmtNum(pl.prs_open)} open PRs` }),
      pl.pr_age_oldest_h != null ? jsx('span', { children: `oldest PR ${pl.pr_age_oldest_h}h` }) : null,
      pl.pr_merge_lead_h != null ? jsx('span', { children: `open→merge ${pl.pr_merge_lead_h}h` }) : null,
      jsx('span', { children: `${fmtNum(pl.prs_merged_7d)} merged in 7d` }),
      jsx('span', { children: `CI 24h: ${fmtNum(ci.ok_24h)} ok / ${fmtNum(ci.failed_24h)} failed` }),
      jsx('span', { children: `deploy 24h: ${fmtNum(dp.ok_24h)} ok / ${fmtNum(dp.failed_24h)} failed` }),
      pl.refreshing
        ? jsx('span', { className: 'mc-dim', children: 'refreshing…' })
        : jsx('span', { className: 'mc-dim', children: `as of ${Math.round(pl.cache_age_seconds || 0)}s ago` })
    ] }),
    dp.names && dp.names.length
      ? jsx('div', { className: 'mc-mono', children: `deploy workflows on main: ${dp.names.join(' · ')}` })
      : jsx('div', { className: 'mc-dim', children: 'no deploy workflow run on main in the last 100 runs — that leg is idle.' }),
    pl.partial && pl.partial.length
      ? jsx('div', { className: 'mc-note', children: `partial read (${pl.partial.join(', ')} failed) — treat these numbers as incomplete.` })
      : null
  ] })
}

function RailStrip({ rails }) {
  const rows = (rails || []).filter(r => r.wip || r.entered)
  if (!rows.length) return jsx('div', { className: 'mc-dim', children: 'Nothing is parked on this board.' })
  return jsx('div', { className: 'mc-rail', children: rows.map(r =>
    jsxs('div', { className: 'mc-rail-box', 'data-hot': r.wip > 20 ? 'true' : undefined, children: [
      jsx('div', { className: 'mc-rail-k', children: r.label }),
      jsx('div', { className: 'mc-rail-v', children: fmtNum(r.wip) }),
      jsx('div', { className: 'mc-dim', children: `${fmtNum(r.entered)} parked in 7d` })
    ] }, r.id)) })
}

function ReworkStrip({ project }) {
  const label = id => {
    const s = (project.stages || []).find(x => x.id === id)
    return s ? s.label : id
  }
  const rows = (project.edges || []).filter(e => e.direction === 'rework' && e.count > 0)
  if (!rows.length) return jsx('div', { className: 'mc-dim', children: 'No rework edges measured in this window.' })
  return jsxs('div', { className: 'mc-flow', children: [
    jsx('div', { className: 'mc-row-m', children: rows.map(e =>
      jsx('span', { className: 'mc-chip', children: `${label(e.from)} → ${label(e.to)} · ${fmtNum(e.count)}` }, `${e.from}-${e.to}`)) }),
    jsx('div', { className: 'mc-dim', children: `${fmtNum(project.rework)} card moves went BACKWARD through the line in this window — work being redone, not new work.` })
  ] })
}

function ProjectFlowCard({ project, initialOpen }) {
  const [open, setOpen] = useState(!!initialOpen)
  const stages = project.stages || []
  const constraint = stages.find(s => s.constraint)
  const onLine = stages.reduce((n, s) => n + (s.wip || 0), 0)
  return jsxs('div', { className: 'mc-card', children: [
    jsxs('div', { className: 'mc-card-h', children: [
      jsx(Badge, { children: project.unattached ? 'board' : 'project' }),
      jsx('span', { className: 'mc-card-t-inline', children: project.name }),
      jsx('span', { className: 'mc-mono', children: `board ${project.board}` }),
      project.repo ? jsx('span', { className: 'mc-mono', children: project.repo }) : null,
      jsx('div', { style: { flex: '1 1 auto' } }),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => { haptic('tap'); setOpen(!open) }, children: open ? 'collapse' : 'expand' })
    ] }),
    project.error ? jsx('div', { className: 'mc-note', children: `board read failed: ${project.error}` }) : null,
    project.board_found ? null
      : jsx('div', { className: 'mc-note', children: 'No kanban board on this box for this project yet, so there is no flow to measure.' }),
    constraint
      ? jsxs('div', { className: 'mc-row-m', children: [
        jsx('span', { className: 'mc-chip mc-chip-hot', children: `CONSTRAINT · ${constraint.label}` }),
        jsx('span', { children: `${fmtNum(constraint.wip)} waiting` }),
        jsx('span', { children: `${fmtNum(constraint.queue_hours)} queue-hours` }),
        constraint.wait_h != null
          ? jsx('span', { children: `~${fmtNum(constraint.wait_h)}h to clear at the measured exit rate` })
          : jsx('span', { children: 'exit rate not instrumented' }),
        constraint.net_per_day != null
          ? jsx('span', { children: `net ${constraint.net_per_day > 0 ? '+' : ''}${constraint.net_per_day}/day` })
          : null
      ] })
      : (project.board_found ? jsx('div', { className: 'mc-dim', children: 'Nothing in flight on this board.' }) : null),
    open ? jsxs('div', { className: 'mc-flow', children: [
      jsx(FlowPipe, { stages, edges: project.edges, height: 200, ariaLabel: `${project.name} value stream` }),
      jsx(StageTable, { stages }),
      jsx(Section, { title: 'Parked work — the side rails', sub: 'what left the line, and why',
        children: jsx(RailStrip, { rails: project.rails }) }),
      jsx(Section, { title: 'Rework — cards moving backward', children: jsx(ReworkStrip, { project }) }),
      jsx(Section, { title: 'Code leg — PR → CI → merge → deploy', sub: project.repo || 'no repo resolved',
        children: jsx(PipelineLeg, { pl: project.pipeline, repo: project.repo }) }),
      jsxs('div', { className: 'mc-row-m', children: [
        jsx('span', { children: `${fmtNum(onLine)} cards on the line` }),
        jsx('span', { children: `${fmtNum(project.done_total)} shipped all-time` }),
        jsx('span', { children: `${fmtNum(project.churn)} runs crashed or gave up in window` }),
        jsx('span', { className: 'mc-dim', children: `flow window ${project.window_hours}h` })
      ] })
    ] }) : null
  ] }, project.key)
}

function FlowPage() {
  useCss()
  const [windowHours, setWindowHours] = useState(168)
  const [only, setOnly] = useState(null)
  const q = useRest('/flow?window_hours=' + windowHours, 30000)
  const d = q.data
  const projects = (d || {}).projects || []
  const shown = only ? projects.filter(p => p.key === only) : projects

  if (q.isError) {
    return jsxs('div', { className: 'mc-page', children: [
      jsx(ErrorState, { title: 'The flow is unreachable' }) ] })
  }
  if (!d) return jsxs('div', { className: 'mc-page', children: jsx(GlyphSpinner, {}) })

  const constraints = projects
    .map(p => ({ p, c: (p.stages || []).find(s => s.constraint) }))
    .filter(x => x.c && x.c.wip > 0)
    .sort((a, b) => (b.c.queue_hours || 0) - (a.c.queue_hours || 0))

  return jsxs('div', { className: 'mc-page', children: [
    jsxs('div', { className: 'mc-head', children: [
      jsx('div', { className: 'mc-sec-t', style: { fontSize: '15px' }, children: 'Flow' }),
      jsx('div', { className: 'mc-sec-s', children: `value stream for ${projects.length} project${projects.length === 1 ? '' : 's'} · updated ${ago(d.generated_at)} · auto-refresh 30s` }),
      jsx('div', { style: { flex: '1 1 auto' } }),
      [168, 336, 720].map(h => jsx(Button, {
        key: h, variant: 'ghost', size: 'sm', disabled: windowHours === h,
        onClick: () => { haptic('tap'); setWindowHours(h) }, children: `${h / 24}d`
      }, h)),
      jsx(Button, { variant: 'ghost', size: 'sm', onClick: () => void invalidate(), children: 'refresh' })
    ] }),

    jsx(Section, {
      title: 'Where the work is stuck',
      sub: 'ranked by queue-hours — how long the cards sitting there have already waited, added up',
      children: constraints.length
        ? jsx('div', { className: 'mc-flow-stages', children: constraints.map(x => jsxs('div', {
          className: 'mc-flow-stage', 'data-tone': 'hot', children: [
            jsxs('div', { className: 'mc-flow-stage-h', children: [
              jsx('span', { className: 'mc-flow-stage-t', children: x.p.name }),
              jsx('span', { className: 'mc-chip mc-chip-hot', children: x.c.label })
            ] }),
            jsx('div', { className: 'mc-flow-stage-v', children: fmtNum(x.c.wip) }),
            jsx('div', { className: 'mc-flow-stage-m', children: stageLine(Object.assign({}, x.c, { window_hours: x.p.window_hours })) })
          ]
        }, x.p.key)) })
        : jsx('div', { className: 'mc-dim', children: 'No stage is carrying a queue on any project right now.' })
    }),

    jsxs('div', { className: 'mc-chips', children: [
      jsx('button', { className: 'mc-chip' + (only ? '' : ' mc-chip-on'), onClick: () => setOnly(null), children: 'every project' }),
      projects.map(p => jsx('button', {
        key: p.key, className: 'mc-chip' + (only === p.key ? ' mc-chip-on' : ''),
        onClick: () => { haptic('tap'); setOnly(only === p.key ? null : p.key) }, children: p.name
      }, p.key))
    ] }),

    shown.map(p => jsx(ProjectFlowCard, {
      key: p.key, project: p, initialOpen: !p.unattached
    }, p.key)),

    jsx(Section, {
      title: 'How to read this',
      children: jsxs('div', { className: 'mc-flow', children: [
        jsx('div', { className: 'mc-row-m', children: 'Band thickness is how many cards are in that stage right now — a hairline means no load at all, and the widest band is where work has piled up. The outlined band is the constraint.' }),
        jsx('div', { className: 'mc-row-m', children: 'Each stage is labelled flowing (under ~2h to clear), slowing, backed up, idle, or a queue whose exit is not instrumented — that last case is reported as unmeasured rather than as a zero.' }),
        jsx('div', { className: 'mc-row-m', children: `Occupancy is live. Flow counts are per-card stage events over the last ${windowHours}h. The code leg is cached about 10 minutes because every read is a GitHub API call.` }),
        jsx('div', { className: 'mc-row-m', children: 'Projects come from projects.db; boards with no project record are shown too, so no work is invisible.' })
      ] })
    })
  ] })
}

// ---------------------------------------------------------------- the status-bar chip

function WaitingChip() {
  const waiting = useRest('/waiting', 60000)
  const framed = waiting.data?.totals?.framed
  const label = framed == null ? '…' : `${framed} waiting`
  return jsx(Tip, { label: framed ? `${framed} decisions are parked on you` : 'nothing waiting on you', children: jsx('button', {
    type: 'button',
    className: cn('inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
      'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'),
    onClick: () => { haptic('tap'); host.navigate(WAITING) },
    children: [
      framed ? jsx('span', { className: 'mc-dot' }) : null,
      jsx('span', { children: label })
    ]
  }) })
}

export default {
  id: ID,
  name: 'Mission Control',
  description: 'Estate-wide view of the work: what every bot is running, what is parked on you, what is stuck, and how fast it all moves.',
  defaultEnabled: true,
  register(ctx) {
    rest = (path, opts) => ctx.rest(path, opts)
    ctx_writeClipboard = text => ctx.os.writeClipboard(text)
    storage = ctx.storage
    startAskWatch(ctx)

    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: WAITING }, render: () => jsx(MissionControlPage, {}) },
      { id: 'insights', area: ROUTES_AREA, data: { path: INSIGHTS }, render: () => jsx(InsightsPage, {}) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, data: { path: WAITING, label: 'Mission Control', codicon: 'dashboard' } },
      { id: 'nav-insights', area: SIDEBAR_NAV_AREA, data: { path: INSIGHTS, label: 'Insights', codicon: 'graph' } },
      { id: 'chip', area: STATUSBAR_AREAS.right, order: 120, render: () => jsx(WaitingChip, {}) },
      {
        id: 'open', area: PALETTE_AREA,
        data: { id: 'mission-control.open', label: 'Mission Control: open', keywords: ['mission', 'control', 'estate', 'waiting'], run: () => host.navigate(WAITING) }
      },
      {
        id: 'open-insights', area: PALETTE_AREA,
        data: { id: 'mission-control.insights', label: 'Mission Control: insights', keywords: ['mission', 'control', 'insights', 'stuck', 'throughput'], run: () => host.navigate(INSIGHTS) }
      },
      {
        id: 'bind', area: KEYBINDS_AREA,
        data: { id: 'mission-control.open', label: 'Open Mission Control', category: 'Mission Control', defaults: ['mod+shift+m'], run: () => host.navigate(WAITING) }
      },
      { id: 'estate', area: ROUTES_AREA, data: { path: ESTATE }, render: () => jsx(EstatePage, {}) },
      { id: 'waiting', area: ROUTES_AREA, data: { path: WAITING_ON_ME }, render: () => jsx(WaitingOnMePage, {}) },
      { id: 'projects', area: ROUTES_AREA, data: { path: PROJECTS }, render: () => jsx(ProjectsPage, {}) },
      { id: 'flow', area: ROUTES_AREA, data: { path: FLOW }, render: () => jsx(FlowPage, {}) },
      { id: 'nav-flow', area: SIDEBAR_NAV_AREA, data: { path: FLOW, label: 'Flow', codicon: 'graph-line' } },
      {
        id: 'open-flow', area: PALETTE_AREA,
        data: {
          id: 'mission-control.flow', label: 'Mission Control: flow (where the work is stuck)',
          keywords: ['mission', 'control', 'flow', 'funnel', 'value stream', 'bottleneck', 'constraint', 'pipeline'],
          run: () => host.navigate(FLOW)
        }
      },
      { id: 'nav-estate', area: SIDEBAR_NAV_AREA, data: { path: ESTATE, label: 'Estate', codicon: 'server-process' } },
      { id: 'nav-waiting', area: SIDEBAR_NAV_AREA, data: { path: WAITING_ON_ME, label: 'Waiting on Me', codicon: 'inbox' } },
      { id: 'nav-projects', area: SIDEBAR_NAV_AREA, data: { path: PROJECTS, label: 'Projects', codicon: 'briefcase' } },
      {
        id: 'workspace', area: PALETTE_AREA,
        data: {
          id: 'mission-control.workspace', label: 'Mission Control: open the waiting list as a tab',
          keywords: ['mission', 'control', 'waiting', 'decisions', 'workspace'], run: () => openWaitingWorkspace()
        }
      },
      {
        id: 'workspace-bind', area: KEYBINDS_AREA,
        data: {
          id: 'mission-control.workspace', label: 'Open the waiting list as a workspace tab',
          category: 'Mission Control', defaults: ['mod+shift+w'], run: () => openWaitingWorkspace()
        }
      },
      {
        // The agent renders a live card inline by writing a paragraph that is exactly
        // ::mc-card{id="t_…"} — a framed owner ask arrives with its options as buttons, answerable
        // from the message. Namespaced (mc-card) because first registration wins on a name.
        id: 'directive', area: TRANSCRIPT_DIRECTIVE_AREA,
        data: { name: 'mc-card', render: ({ attrs }) => jsx(CardDirective, { attrs }) }
      }
    ])
  }
}
