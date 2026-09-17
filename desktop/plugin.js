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
      jsx('div', { className: 'mc-sec-s', children: `estate-wide · updated ${relativeTime(d.generated_at)}` }),
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
    jsxs('div', { className: 'mc-grid2', children: [
      jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' }, children: [
        jsx(Section, {
          title: 'Waiting on you — answer in place',
          sub: `${framed.length} shown of ${d.awaiting?.framed_total || 0} framed`,
          right: jsx('input', {
            placeholder: 'filter…', value: q, onChange: e => setQ(e.target.value),
            style: { background: 'transparent', border: '1px solid var(--ui-stroke-secondary)', borderRadius: '5px', padding: '2px 6px', fontSize: '11px', color: 'var(--ui-text-secondary)' }
          }),
          children: framed.length
            ? framed.map(i => jsx(AskRow, { item: i, onDone: refresh }, `${i.board}${i.id}`))
            : jsx(EmptyState, { title: 'Nothing framed for you right now' })
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
            jsx('span', { children: j.next_run_at ? relativeTime(j.next_run_at) : '' })
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
      jsx('div', { className: 'mc-sec-s', children: `window ${d.window_hours}h · updated ${relativeTime(d.generated_at)}` }),
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
        jsx(Section, { title: 'Schedule health', sub: `${sched.enabled || 0} enabled · ${sched.paused || 0} paused`, children: [
          (sched.failing || []).length ? (sched.failing || []).map(j => jsxs('div', { className: 'mc-row', children: [
            jsx('div', { className: 'mc-row-t', children: j.name || j.id }),
            jsxs('div', { className: 'mc-row-m', children: [jsx('span', { children: `streak ${j.failure_streak}` }), jsx('span', { children: j.profile }), jsx('span', { children: j.schedule || '' })] })
          ] }, `${j.profile}${j.id}`)) : jsx(EmptyState, { title: 'every schedule is healthy' }),
          jsx(Separator, {}),
          (sched.upcoming || []).slice(0, 6).map(j => jsxs('div', { className: 'mc-row-m', children: [
            jsx('span', { children: j.next_run_at ? relativeTime(j.next_run_at) : '—' }),
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
    sub: delta.since ? `since ${relativeTime(delta.since)}` : undefined,
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
  const scheduled = all.filter(p => p.jobs)
  const working = all.filter(p => !p.jobs && (p.running || p.open || p.blocked))
  const idle = all.filter(p => !p.jobs && !p.running && !p.open && !p.blocked)

  const botRow = p => jsxs('div', { className: 'mc-row', children: [
    jsxs('div', { className: 'mc-row-m', children: [
      jsx('span', { className: p.jobs_failing ? 'mc-warn-text' : undefined, children: p.profile }),
      p.jobs ? jsx('span', { children: `${p.jobs_enabled}/${p.jobs} jobs` }) : null,
      p.jobs_failing ? jsx(Badge, { variant: 'outline', children: `${p.jobs_failing} failing` }) : null,
      p.last_status ? jsx('span', { children: `last: ${p.last_status}` }) : null,
      p.next_run_at ? jsx('span', { children: `next ${relativeTime(p.next_run_at)}` }) : null
    ] }),
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
      jsx('div', { className: 'mc-sec-s', children: `every bot · window ${d.window_hours}h · updated ${relativeTime(d.generated_at)}` }),
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
    jsx(Section, { title: 'Bots with a schedule', sub: `${scheduled.length} profiles`, children: scheduled.map(botRow) }),
    jsx(Section, { title: 'Bots with a plate, no schedule', sub: `${working.length} profiles`, children: working.length ? working.map(botRow) : jsx(EmptyState, { title: 'none' }) }),
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
      { id: 'nav-estate', area: SIDEBAR_NAV_AREA, data: { path: ESTATE, label: 'Estate', codicon: 'server-process' } },
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
