/**
 * Headless render check for the Mission Control DESKTOP half's Flow page.
 *
 * The desktop half is loaded by Electron as raw ESM with only three resolvable specifiers, so
 * node cannot import it as-is. This harness rewrites the import block into stubs — a tiny fake
 * React (jsx/jsxs build plain objects, hooks return real values) and the SDK surface the file
 * names — then registers the plugin, renders the REAL components against a REAL /flow payload,
 * and asserts on the resulting element tree.
 *
 * Catches: a ReferenceError in a path that only runs with data, NaN/undefined leaking into SVG
 * geometry, a missing component, a stage the payload does not carry, a route that did not
 * register. Does not catch pixels — the rendered look still needs the owner's app.
 *
 *   node tests/render-check.mjs [plugin.js] [flow-payload.json]
 *
 * The payload comes from the plugin's own route:
 *   curl -s -H "X-Hermes-Session-Token: $TOK" \
 *     http://127.0.0.1:9121/api/plugins/mission-control/flow > /tmp/flow-payload.json
 * (the live dashboard is auth-gated, so mint an operator token and start a spare loopback
 *  instance; see the hermes-dashboard-plugin skill.)
 */
import fs from 'node:fs'

const SRC = process.argv[2] || '/home/hermes/.hermes/plugins/mission-control/desktop/plugin.js'
const PAYLOAD = JSON.parse(fs.readFileSync(process.argv[3] || '/tmp/flow-payload.json', 'utf8'))

let src = fs.readFileSync(SRC, 'utf8')
const sdkNames = ['Badge', 'Button', 'cn', 'EmptyState', 'ErrorState', 'GlyphSpinner',
  'KEYBINDS_AREA', 'PALETTE_AREA', 'ROUTES_AREA', 'SIDEBAR_NAV_AREA', 'Separator',
  'STATUSBAR_AREAS', 'Tip', 'TRANSCRIPT_DIRECTIVE_AREA']
const explicit = ['host', 'haptic', 'queryClient', 'relativeTime']

const before = src.length
src = src.replace(/^import \{[\s\S]*?\} from '@hermes\/plugin-sdk'\n/m, '')
src = src.replace(/^import \{[\s\S]*?\} from 'react'\n/m, '')
src = src.replace(/^import \{[\s\S]*?\} from 'react\/jsx-runtime'\n/m, '')
if (src.length === before) throw new Error('import rewrite matched nothing — check the import block')
src = src.replace(/^export default \{/m, 'const __plugin = {')

const prelude = `
const __registered = {}
// A mini renderer: function components are CALLED (so the whole tree is really built),
// string/host types stay as elements.
const jsx = (type, props, key) => (typeof type === 'function'
  ? type(props || {})
  : { type, props: props || {}, key })
const jsxs = jsx
const useState = (init) => [typeof init === 'function' ? init() : init, () => {}]
const useEffect = () => {}
const useMemo = (fn) => fn()
const useCallback = (fn) => fn
${sdkNames.filter(n => !explicit.includes(n)).map(n => `const ${n} = ${JSON.stringify(n)}`).join('\n')}
const host = { navigate: () => {} }
const haptic = () => {}
const queryClient = { invalidateQueries: () => {} }
const relativeTime = () => 'just now'
const __PAYLOAD = ${JSON.stringify(PAYLOAD)}
const useQuery = () => ({ data: __PAYLOAD, isError: false, error: null, load: () => {} })
const document = { createElement: () => ({ textContent: '', remove() {} }), head: { append() {} } }
`

// The ctx stub must carry EVERY door register() opens (onDispose included), or register aborts
// before registerMany and the route assertions below pass against an empty registry.
const tail = `
__plugin.register({
  rest: () => Promise.resolve({}),
  os: { writeClipboard: () => {}, notify: () => {} },
  storage: { get: () => null, set() {}, remove() {} },
  onDispose: () => {},
  registerMany: (arr) => { arr.forEach(x => { __registered[x.id] = x }) },
  socket: null
})
globalThis.__probe = { __registered, __plugin, FlowPage, ProjectFlowCard, PipelineLeg, FlowPipe,
  StageTable, stageVerdict, stageLine, pipelineStages }
`

const out = '/tmp/mc-desktop-transformed.mjs'
fs.writeFileSync(out, prelude + '\n' + src + '\n' + tail)
await import(out + '?t=' + Date.now())
const P = globalThis.__probe

const fails = []
const ok = (cond, msg) => { if (!cond) fails.push(msg) }

// ---- 1. the page renders, with data ---------------------------------------
const tree = P.FlowPage()
ok(!!tree && tree.type === 'div', 'FlowPage did not return a div')
const flat = []
const walk = node => {
  if (node == null || node === false) return
  if (Array.isArray(node)) return node.forEach(walk)
  if (typeof node !== 'object') { flat.push(String(node)); return }
  if (node.key != null) flat.push('key=' + node.key)
  if (node.props) {
    for (const [k, v] of Object.entries(node.props)) {
      if (k === 'children') walk(v)
      else if (typeof v === 'string' || typeof v === 'number') flat.push(`${k}=${v}`)
    }
  }
}
walk(tree)
const text = flat.join(' | ')
const json = JSON.stringify(tree)

// Bands are collected as ELEMENTS, never as key strings. A band's stage id lives only in its
// key, and `json`/`flat` keep those strings even when the band never reached the tree — which
// is exactly what `jsx(type, props, children)` does when children lands in `key`. This is the
// assertion that has to be able to fail on that bug.
const bandKeys = node => {
  const found = []
  const run = n => {
    if (n == null || n === false) return
    if (Array.isArray(n)) return n.forEach(run)
    if (typeof n !== 'object') return
    const cls = n.props && n.props.className
    if (typeof cls === 'string' && cls.startsWith('mc-flow-band')) found.push(n.key)
    if (n.props && n.props.children) run(n.props.children)
  }
  run(node)
  return found
}

// ---- 2. no NaN / undefined leaks into text or geometry --------------------
ok(!/NaN/.test(json), 'NaN appeared in the rendered tree')
ok(!/\bundefined\b/.test(text), 'the literal "undefined" reached rendered text')
ok(!/\bnull\b/.test(text), 'the literal "null" reached rendered text')

// ---- 3. the page says what it must ---------------------------------------
ok(text.includes('Where the work is stuck'), 'the constraint panel is missing')
ok(text.includes('CONSTRAINT'), 'no CONSTRAINT label rendered')
ok(text.includes('How to read this'), 'the legend is missing')
ok(bandKeys(tree).length > 0, 'no flow bands rendered (as elements)')
ok(text.includes('rework'), 'no rework information rendered')

// ---- 4. geometry is finite ------------------------------------------------
const nums = [...json.matchAll(/"(?:x|y|width|height|points|d|viewBox)":"([^"]*)"/g)].map(m => m[1])
ok(nums.length > 0, 'no svg geometry found at all')
const bad = nums.filter(v => /NaN|undefined|Infinity/.test(v))
ok(bad.length === 0, 'non-finite svg geometry: ' + bad.slice(0, 3).join(' ; '))

// ---- 5. every non-terminal stage in the payload got a band ELEMENT ---------
const first = PAYLOAD.projects.find(p => p.board_found && (p.stages || []).length)
if (first) {
  const want = first.stages.filter(x => !x.terminal).length
  const bands = bandKeys(tree)
  ok(bands.length >= want, `only ${bands.length} band ELEMENTS for ${want} non-terminal stages`)
  for (const s of first.stages.filter(x => !x.terminal)) {
    ok(bands.includes(`band-${s.id}`), `no band ELEMENT reached the tree for stage ${s.id}`)
  }
  // ---- 5b. a COLLAPSED project card still draws its funnel -----------------
  // The funnel is the page: it must not be something only expanding reveals. A card that
  // is collapsed renders the same diagram at a smaller height.
  if (P.ProjectFlowCard) {
    const closed = bandKeys(P.ProjectFlowCard({ project: first, initialOpen: false }))
    ok(closed.length >= want,
      `a COLLAPSED project card drew ${closed.length} bands, not ${want} — the funnel is hidden until you expand`)
  }
}

// ---- 6. the pipeline leg renders in every state --------------------------
const warm = P.PipelineLeg({ pl: { repo: 'x/y', measured: false, warming: true }, repo: 'x/y' })
ok(JSON.stringify(warm).includes('reading GitHub'), 'warming state does not say what it is doing')
const err = P.PipelineLeg({ pl: { repo: 'x/y', measured: false, error: 'gh timed out' }, repo: 'x/y' })
ok(JSON.stringify(err).includes('gh timed out'), 'an error state hides the error')
const norepo = P.PipelineLeg({ pl: null, repo: null })
ok(JSON.stringify(norepo).includes('No git remote'), 'a project with no repo does not say so')
const measured = PAYLOAD.projects.map(p => p.pipeline).find(pl => pl && pl.measured)
if (measured) {
  const t = JSON.stringify(P.PipelineLeg({ pl: measured, repo: measured.repo }))
  ok(t.includes('Deploys running'), 'a measured pipeline does not render the deploy leg')
}

// ---- 7. registration -----------------------------------------------------
const reg = P.__registered
ok(Object.keys(reg).length > 5, 'registerMany produced almost nothing — the ctx stub is incomplete')
ok(!!reg.flow, 'the Flow route is not registered')
ok(!!reg['nav-flow'], 'the Flow sidebar row is not registered')
ok(!!reg['open-flow'], 'the Flow palette command is not registered')
ok(reg.flow && reg.flow.data.path === '/mission-control/flow', 'the Flow route path is wrong')
ok(!!reg.projects, 'the Projects route vanished')

if (fails.length) {
  console.error('RENDER CHECK FAILED (' + fails.length + '):')
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
console.log('render check OK — ' + flat.length + ' rendered props, ' + nums.length +
            ' geometry values, 0 non-finite, ' + Object.keys(reg).length + ' registrations')
console.log('  first project: ' + first.name + ' · stages drawn ' +
            first.stages.filter(s => !s.terminal).length + ' · constraint ' +
            ((first.stages.find(s => s.constraint) || {}).label || 'none'))
process.exit(0)   // startAskWatch leaves an interval open; the check is done
