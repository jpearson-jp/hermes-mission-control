/**
 * The /waiting EXCLUDED bucket — asserted on BOTH halves, from the payload, headlessly.
 *
 * WHAT THIS IS FOR (kanban tos:t_4a19b847). `GET /waiting` answers with FOUR buckets:
 *
 *   totals.framed     framed asks with options          (52)
 *   totals.parked     parked needs_input, no framed ask (78)
 *   totals.excluded   parked needs_input the reader DROPS, and names
 *                     -> excluded = {count, by_reason, named}   (12)
 *   totals.needs_input = the three above                  (142)
 *
 * Both front ends rendered three tiles and summed framed+parked, so the owner was shown 130 (+2)
 * against a true 142, none of the 12 excluded cards was named anywhere, and the headline counted 52
 * "asks with options" when only 45 carried a RECOMMENDATION — the same 45 the bulk Accept-all
 * control offers. The fix is display-only, but the page is a static bundle with no test surface of
 * its own, so the only honest proof is to build the REAL component tree and assert on it.
 *
 *   node tests/waiting-excluded-check.mjs [desktop.js] [waiting.js] [live-waiting-payload.json]
 *
 * Defaults are the LIVE plugin repo's two halves. The optional third argument is a real /waiting
 * body (curl it with an operator token; the dashboard is auth-gated) and runs the same assertions
 * against the numbers the estate is ACTUALLY serving — that is the check to run before you believe
 * either half is fixed.
 *
 * Catches: a bucket the UI silently drops, a headline that promises more than the control can do, a
 * total that no longer reconciles, a named exclusion that never reaches the DOM, NaN/undefined
 * leaking into rendered text. Does not catch pixels — the rendered look still needs the owner's app.
 */
import fs from 'node:fs'

const ROOT = '/home/hermes/.hermes/plugins/mission-control'
const DESKTOP = process.argv[2] || ROOT + '/desktop/plugin.js'
const BROWSER = process.argv[3] || ROOT + '/src/pages/waiting.js'
const LIVE_PATH = process.argv[4] || null

// ── the fixtures ────────────────────────────────────────────────────────────────────────────────
// The live shape MEASURED on 2026-09-26: 52 framed (45 with a recommendation, 7 without), 78 parked,
// 12 excluded (8 already answered · 4 duplicate) => needs_input 142.
function makeFixture(excludedCount) {
  const framed = []
  for (let i = 1; i <= 52; i++) {
    framed.push({
      board: 'tos', id: 't_ask' + i, title: 'framed ask ' + i, assignee: 'eng-lead',
      status: 'needs_input', age_seconds: 600 * i, ask: 'pick one of these', options: ['a', 'b'],
      recommendation: i <= 45 ? 1 : null, hints: ['decision']
    })
  }
  const parked = []
  for (let i = 1; i <= 78; i++) {
    parked.push({ board: 'tos', id: 't_park' + i, title: 'parked ' + i, age_seconds: 600 })
  }
  const named = []
  for (let i = 1; i <= 8; i++) named.push('tos/t_answered' + i + ' already answered 2026-09-2' + i + 'T04:00:00Z')
  for (let i = 1; i <= 4; i++) named.push('tos/t_dup' + i + ' duplicate of tos/t_carrier' + i)
  const keep = Math.max(0, Math.min(12, excludedCount))
  return {
    generated_at: '2026-09-26T04:19:00Z',
    boards: [{ slug: 'tos' }, { slug: 'ops' }],
    oldest_seconds: 600 * 52,
    totals: { framed: 52, parked: 78, excluded: keep, needs_input: 52 + 78 + keep },
    framed, parked, aging: [], tags: {},
    excluded: {
      count: keep,
      by_reason: keep === 12 ? { 'already answered': 8, duplicate: 4 } : {},
      named: keep === 12 ? named : []
    }
  }
}
// The empty-framed case is the one that printed "Nothing is waiting on you" / "clear board" while 12
// cards sat excluded — the "nothing here" claim the acceptance forbids.
function makeEmptyFramedFixture() {
  const f = makeFixture(12)
  f.totals.framed = 0
  f.totals.parked = 0
  f.totals.needs_input = 12
  f.framed = []
  f.parked = []
  return f
}

const CASES = [
  { name: 'excluded = 12', payload: makeFixture(12) },
  { name: 'excluded = 0', payload: makeFixture(0) },
  { name: 'excluded = 12, nothing framed', payload: makeEmptyFramedFixture() }
]
if (LIVE_PATH) CASES.push({ name: 'LIVE payload ' + LIVE_PATH, payload: JSON.parse(fs.readFileSync(LIVE_PATH, 'utf8')), live: true })

// ── the tree walker (shared by both halves) ─────────────────────────────────────────────────────
function walkTree(root) {
  const tokens = [], elements = []
  const run = n => {
    if (n == null || n === false || n === true) return
    if (Array.isArray(n)) return n.forEach(run)
    if (typeof n !== 'object') { tokens.push(String(n)); return }
    if (n.key != null) tokens.push(String(n.key))
    elements.push(n)
    const p = n.props || {}
    for (const [k, v] of Object.entries(p)) {
      if (k === 'children') run(v)
      else if (typeof v === 'string' || typeof v === 'number') tokens.push(String(v))
    }
  }
  run(root)
  return { tokens, elements, text: tokens.join(' | '), json: JSON.stringify(root) }
}
// The headline buckets, read the way a person reads them: the bucket element and its props.
// The browser half renders <Stat> (a stub string here), so k/v/n arrive as props. The desktop half's
// <Tile> is a REAL component in the file, so the mini renderer CALLS it and what reaches the tree is
// div.mc-tile > div.mc-tile-k / -v / -n — read the numbers off those.
function childrenText(node) {
  const out = []
  const run = n => {
    if (n == null || n === false || n === true) return
    if (Array.isArray(n)) return n.forEach(run)
    if (typeof n === 'object') return run((n.props || {}).children)
    out.push(String(n))
  }
  run(node)
  return out.join(' ')
}
function readBuckets(kind, elements) {
  if (kind === 'browser') {
    return elements.filter(e => String(e.type) === 'Stat')
      .map(e => Object.assign({ text: childrenText({ props: e.props }) }, e.props))
  }
  const out = []
  for (const e of elements) {
    if ((e.props || {}).className !== 'mc-tile') continue
    const kids = Array.isArray(e.props.children) ? e.props.children : [e.props.children]
    const by = {}
    for (const c of kids) {
      const cls = c && c.props && c.props.className
      if (typeof cls === 'string' && cls.indexOf('mc-tile-') === 0) by[cls.slice(8)] = childrenText(c)
    }
    out.push({ k: by.k, v: by.v, n: by.n, text: childrenText(e) })
  }
  return out
}

// ── the two readers, each transformed into something node can import ────────────────────────────
const sdkNames = ['Badge', 'Button', 'cn', 'EmptyState', 'ErrorState', 'GlyphSpinner',
  'KEYBINDS_AREA', 'PALETTE_AREA', 'ROUTES_AREA', 'SIDEBAR_NAV_AREA', 'Separator',
  'STATUSBAR_AREAS', 'Tip', 'TRANSCRIPT_DIRECTIVE_AREA']
const explicit = ['host', 'haptic', 'queryClient', 'relativeTime']

const MINI = `
const jsx = (type, props, key) => (typeof type === 'function' ? type(Object.assign({}, props, { key })) : { type, props: Object.assign({}, props, { key }) })
const jsxs = jsx
const useState = (init) => [typeof init === 'function' ? init() : init, () => {}]
const useEffect = () => {}
const useMemo = (fn) => fn()
const useCallback = (fn) => fn
const __noop = () => {}
`

function desktopModule(payload) {
  const srcPath = DESKTOP
  let src = fs.readFileSync(srcPath, 'utf8')
  const before = src.length
  src = src.replace(/^import \{[\s\S]*?\} from '@hermes\/plugin-sdk'\n/m, '')
  src = src.replace(/^import \{[\s\S]*?\} from 'react'\n/m, '')
  src = src.replace(/^import \{[\s\S]*?\} from 'react\/jsx-runtime'\n/m, '')
  if (src.length === before) throw new Error('the desktop import rewrite matched nothing — check the import block')
  src = src.replace(/^export default \{/m, 'const __plugin = {')
  const prelude = MINI + `
__PLUGIN_SDK_SILENCE__
const __registered = {}
const cn = (...parts) => parts.filter(Boolean).join(' ')
${sdkNames.filter(n => !explicit.includes(n) && n !== 'cn').map(n => `const ${n} = ${JSON.stringify(n)}`).join('\n')}
const host = { navigate: () => {} }
const haptic = () => {}
const queryClient = { invalidateQueries: () => {} }
const relativeTime = () => 'just now'
const __PAYLOAD = ${JSON.stringify(payload)}
const useQuery = () => ({ data: __PAYLOAD, isError: false, error: null, load: () => {}, invalidate: () => {} })
const document = { createElement: () => ({ textContent: '', remove() {} }), head: { append() {} }, addEventListener: () => {} }
`
  const tail = `
__plugin.register({
  rest: () => Promise.resolve({}),
  os: { writeClipboard: () => {}, notify: () => {} },
  storage: { get: () => null, set() {}, remove() {} },
  onDispose: () => {},
  registerMany: (arr) => { arr.forEach(x => { __registered[x.id] = x }) },
  socket: null
})
globalThis.__probe = { __registered, __plugin, WaitingOnMePage, WaitingChip,
  excludedReasons: typeof excludedReasons === 'function' ? excludedReasons : null,
  excludedRows: typeof excludedRows === 'function' ? excludedRows : null }
`
  const out = '/tmp/mc-desktop-waiting.mjs'
  fs.writeFileSync(out, prelude.replace('__PLUGIN_SDK_SILENCE__', '') + '\n' + src + '\n' + tail)
  return out
}

// The browser half is a FRAGMENT: the bundle is a header + core.js + this file, all in one scope, so
// the globals it leans on are stubbed here instead of imported. Stubbing them as STRINGS keeps every
// child render as an element we can read props off, and keeps this check independent of core.js.
function browserModule(payload) {
  const src = fs.readFileSync(BROWSER, 'utf8')
  const prelude = `
function h(type, props) {
  const rest = Array.prototype.slice.call(arguments, 2)
  const p = Object.assign({}, props)
  if (rest.length) p.children = rest.length === 1 ? rest[0] : rest
  return typeof type === 'function' ? type(p) : { type, props: p }
}
${MINI}
const __PAYLOAD = ${JSON.stringify(payload)}
function usePoll() { return { state: { data: __PAYLOAD, error: null }, load: function () {} }; }
function useDetail() { return [null, function () {}, null]; }
function num(n) { return n == null ? '—' : String(n); }
function dur(sec) { return sec == null ? '—' : Math.round(sec / 60) + 'm'; }
function hhmm(iso) { return String(iso).slice(11, 16); }
var API = '/api/plugins/mission-control';
function fetchJSON() { return Promise.resolve({ answered: 0, results: [] }); }
var PageHead = 'PageHead', Stat = 'Stat', Panel = 'Panel', HBars = 'HBars', AskRow = 'AskRow',
    Pill = 'Pill', IdChip = 'IdChip', CardTools = 'CardTools';
`
  const tail = `
globalThis.__probe = { WaitingPage,
  mcExcludedReasons: typeof mcExcludedReasons === 'function' ? mcExcludedReasons : null,
  mcExcludedRows: typeof mcExcludedRows === 'function' ? mcExcludedRows : null }
`
  const out = '/tmp/mc-browser-waiting.mjs'
  fs.writeFileSync(out, prelude + '\n' + src + '\n' + tail)
  return out
}

// ── the assertions ──────────────────────────────────────────────────────────────────────────────
const fails = []
const ok = (cond, msg) => { if (!cond) fails.push(msg) }

function checkCase(which, kind, payload, probe) {
  const tree = kind === 'desktop' ? probe.WaitingOnMePage() : probe.WaitingPage()
  const t = payload.totals || {}
  const excCount = Number((payload.excluded || {}).count || 0) || 0
  const framedTotal = Number(t.framed || 0) || 0
  const parkedTotal = Number(t.parked || 0) || 0
  const needsTotal = t.needs_input == null ? null : Number(t.needs_input)
  const reco = (payload.framed || []).filter(i => i.recommendation != null).length
  const named = (payload.excluded || {}).named || []
  const { tokens, elements, text, json } = walkTree(tree)
  const tiles = readBuckets(kind, elements)
  const tag = `[${kind} · ${which}] `
  const has = s => text.indexOf(s) !== -1 || json.indexOf(s) !== -1

  // (a) the EXCLUDED bucket renders as its own bucket, with the payload's number and the reason split
  const excTile = tiles.find(b => Number(b.v) === excCount && excCount > 0)
  const excTitle = has(`Excluded (${excCount})`)
  if (excCount > 0) {
    ok(!!excTile || kind !== 'desktop' || false, tag + 'no tile carries the payload\'s excluded count (' + excCount + ')')
    ok(excTitle, tag + 'no "Excluded (' + excCount + ')" row/section title')
    const split = Object.keys((payload.excluded || {}).by_reason || {})
    ok(split.every(k => has(k)), tag + 'the reason split is not named (' + split.join(', ') + ')')
    ok(named.length === 0 || named.every(n => has(String(n).split(' ')[0])), tag + 'a NAMED exclusion never reached the DOM')
    // the forbidden claim: "nothing here" while cards sit excluded
    ok(!has('Nothing is waiting on you'), tag + 'the page still claims "Nothing is waiting on you" with ' + excCount + ' excluded')
    ok(!has('clear board'), tag + 'the empty state still says "clear board" with ' + excCount + ' excluded')
  }

  // (b) the four buckets RECONCILE, and the receipt is on the page
  if (needsTotal != null) {
    const receipt = framedTotal + ' framed + ' + parkedTotal + ' parked + ' + excCount + ' excluded = ' +
      (kind === 'desktop' ? needsTotal : String(needsTotal)) + ' of ' + (kind === 'desktop' ? needsTotal : String(needsTotal))
    ok(has(receipt), tag + 'the reconciliation receipt is not rendered: "' + receipt + '"')
    const needsShown = tiles.find(b => String(b.v) === String(needsTotal))
    ok(!!needsShown, tag + 'no tile carries needs_input (' + needsTotal + ')')
    ok(framedTotal + parkedTotal + excCount === needsTotal,
      tag + 'the payload itself does not reconcile: ' + framedTotal + '+' + parkedTotal + '+' + excCount + ' != ' + needsTotal)
  }

  // (c) the headline promises only what the bulk control can do
  const head = tiles[0]
  ok(!!head, tag + 'no headline bucket rendered at all')
  if (head && framedTotal > 0) {
    ok(Number(head.v) === reco,
      tag + 'the headline reads ' + head.v + ', not the ' + reco + ' framed asks carrying a recommendation')
    ok(Number(head.v) !== framedTotal,
      tag + 'the headline still counts all ' + framedTotal + ' framed asks (only ' + reco + ' carry a recommendation)')
    ok(String(head.n).indexOf(framedTotal + ' framed asks with options') !== -1,
      tag + 'the headline note drops the framed total (' + framedTotal + ')')
    ok(String(head.n).indexOf(reco + ' of ' + framedTotal) !== -1,
      tag + 'the headline note does not say "' + reco + ' of ' + framedTotal + '"')
  }

  // no NaN/undefined/null leaking into rendered text — and when one does, NAME it.
  // A SHORT token is the tell: a real leak renders as "undefined"/"null"/"NaN" on its own (or as
  // `prop=null`), while a long token is CARD PROSE — a live ask legitimately quotes `mergedAt: null`
  // and `vhd:null`, and failing on that would fail the check for saying the truth.
  const leaks = re => tokens.filter(x => String(x).length <= 40 && re.test(x)).slice(0, 6)
  const badNaN = leaks(/NaN/)
  const badUndef = leaks(/\bundefined\b/)
  const badNull = leaks(/(^|=| )null$/)
  ok(badNaN.length === 0, tag + 'a NaN leaked into rendered text: ' + badNaN.join(' ; '))
  ok(badUndef.length === 0, tag + 'the literal "undefined" reached rendered text: ' + badUndef.join(' ; '))
  ok(badNull.length === 0, tag + 'the literal "null" reached rendered text: ' + badNull.join(' ; '))
  ok(!/:\s*NaN/.test(json), tag + 'NaN appeared in rendered props')
  return { tiles: tiles.length, tokens: tokens.length, buckets: tiles.map(b => b.k + '=' + b.v) }
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────
const report = []
for (const c of CASES) {
  const dMod = await import(desktopModule(c.payload) + '?t=' + Date.now())
  const dProbe = globalThis.__probe
  const dStats = checkCase(c.name, 'desktop', c.payload, dProbe)
  // the status-bar chip reads the SAME payload, so it must not promise 52 either
  if (!c.live) {
    const chip = walkTree(dProbe.WaitingChip())
    if ((c.payload.totals || {}).framed) {
      const reco = (c.payload.framed || []).filter(i => i.recommendation != null).length
      const excCount = Number((c.payload.excluded || {}).count || 0) || 0
      ok(chip.text.indexOf(reco + ' of ' + c.payload.totals.framed + ' framed asks carry a recommendation') !== -1,
        `[desktop chip · ${c.name}] the chip does not name ${reco} of ${c.payload.totals.framed}`)
      if (excCount) {
        ok(chip.text.indexOf(excCount + ' excluded from the inbox') !== -1,
          `[desktop chip · ${c.name}] the chip does not mention the ${excCount} excluded`)
      }
    }
  }

  const bMod = await import(browserModule(c.payload) + '?t=' + Date.now())
  const bProbe = globalThis.__probe
  const bStats = checkCase(c.name, 'browser', c.payload, bProbe)

  report.push(`${c.name}${c.live ? ' (LIVE)' : ''}: desktop ${dStats.tiles} buckets [${dStats.buckets.join(', ')}] · browser ${bStats.tiles} buckets [${bStats.buckets.join(', ')}]`)
}

if (fails.length) {
  console.error('WAITING-EXCLUDED CHECK FAILED (' + fails.length + '):')
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
console.log('waiting-excluded check OK — ' + CASES.length + ' payload(s) × 2 halves')
for (const r of report) console.log('  ' + r)
process.exit(0)