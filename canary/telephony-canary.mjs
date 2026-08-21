/**
 * Synthetic canary for theleadrouter.com — probes the paths that real traffic
 * depends on, INCLUDING the telephony provider's control plane, because the
 * 2026-08-17 SignalWire Call Fabric incident (WebRTC registration + SIP address
 * provisioning down ~12h) was invisible to the provider's own status page.
 *
 * Probes (each independent; one failure fails the run but all still execute):
 *   app-prod        GET  https://theleadrouter.com/api/health
 *   app-staging     GET  staging deployment /api/health (needs bypass secret)
 *   sw-token-mint   POST /api/fabric/subscribers/tokens   (auth + fabric API up)
 *   sw-provision    POST /api/fabric/sip_addresses (create) then DELETE — the
 *                   exact operation that silently broke on 2026-08-17
 *   sw-webrtc-reg   real SDK registration in headless Chrome — the probe that
 *                   catches what the provider's monitors missed
 *   lead-processing GET /api/public/status-latency — real-traffic avg/p95 of
 *   lead-ping         lead ingest→decision and ping→price (metric probes)
 *   call-ping       real mode=availability call-RTB ping round-trip
 *
 * Output: data/status.json (current) — written by the workflow into the repo,
 * consumed by the GitHub Pages status page. NO secrets, ids, or URLs with
 * tokens ever go into the output.
 *
 * Exit code = ALERT, not state: 1 only when the failure set changed vs the
 * previous committed status.json, or a 24h reminder is due while degraded.
 * See the "write result" section. A green Actions run does NOT mean
 * operational — read data/status.json / the status page for current state.
 *
 * Env (all required unless noted):
 *   SW_PROJECT_ID, SW_API_TOKEN, SW_SPACE_HOST   — staging SignalWire project
 *   STAGING_HEALTH_URL, STAGING_BYPASS           — staging health through the SSO wall
 *   CHROME_PATH (optional)                       — headless Chrome binary
 *   SKIP_WEBRTC=1 (optional)                     — skip the browser probe
 *   STATUS_METRICS_SECRET (optional)             — bearer for /api/public/status-latency
 *   CALL_PING_URL, CALL_PING_KEY (optional)      — live availability-mode RTB ping
 */

const CANARY_REF = 'lr-canary-agent'
const results = []

const now = () => new Date().toISOString()

async function probe(name, fn, timeoutMs = 30_000) {
  const started = Date.now()
  try {
    const detail = await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${timeoutMs}ms`)), timeoutMs)),
    ])
    results.push({ name, ok: true, ms: Date.now() - started, detail: detail ?? null })
    console.log(`PASS ${name} (${Date.now() - started}ms)${detail ? ' — ' + detail : ''}`)
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - started, detail: String(err?.message ?? err).slice(0, 200) })
    console.error(`FAIL ${name} (${Date.now() - started}ms) — ${err?.message ?? err}`)
  }
}

const env = (k, optional = false) => {
  const v = process.env[k]
  if (!v && !optional) throw new Error(`missing env ${k}`)
  return v ?? ''
}

const SW = {
  project: env('SW_PROJECT_ID'),
  token: env('SW_API_TOKEN'),
  host: env('SW_SPACE_HOST').replace(/^https?:\/\//, '').replace(/\/$/, ''),
}
const auth = 'Basic ' + Buffer.from(`${SW.project}:${SW.token}`).toString('base64')
const swFetch = (path, init = {}) =>
  fetch(`https://${SW.host}${path}`, {
    ...init,
    headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers ?? {}) },
  })

// ── app health ──────────────────────────────────────────────────────────────
await probe('app-prod', async () => {
  const r = await fetch('https://theleadrouter.com/api/health')
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
  return 'HTTP 200'
})

await probe('app-staging', async () => {
  const url = env('STAGING_HEALTH_URL', true)
  if (!url) return 'skipped (no STAGING_HEALTH_URL)'
  const r = await fetch(url, { headers: { 'x-vercel-protection-bypass': env('STAGING_BYPASS', true) } })
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
  return 'HTTP 200'
})

// ── business latency metrics ────────────────────────────────────────────────
// Real-traffic intake latency, aggregated by the app itself
// (GET /api/public/status-latency, Bearer STATUS_METRICS_SECRET — see
// apps/routing/src/lib/engines/status-latency.ts in the main repo):
//   lead-processing   lead ingested → routing decision (real lead posts)
//   lead-ping         ping received → price returned
// plus one LIVE round-trip:
//   call-ping         a real mode=availability call-RTB ping (write-free by
//                     the route's own contract, excluded from metering)
//
// These are METRIC probes: `metric` (ms) is the number the page shows and
// charts — for the first two it is the platform's measured latency over real
// traffic, NOT this fetch's RTT. Failure semantics: quiet traffic and a
// not-yet-deployed endpoint report ok with an explanatory detail (a red row
// for "the feature hasn't shipped yet" trains people to ignore the board);
// only a live endpoint misbehaving (network error, auth failure, unexpected
// status) fails.
const METRICS_URL = process.env.METRICS_URL || 'https://theleadrouter.com/api/public/status-latency'

function describeWindows(m) {
  if (m.h1.count > 0) return { metric: m.h1.avgMs, detail: `avg ${m.h1.avgMs}ms · p95 ${m.h1.p95Ms}ms (1h, n=${m.h1.count})` }
  if (m.h24.count > 0) return { metric: m.h24.avgMs, detail: `avg ${m.h24.avgMs}ms · p95 ${m.h24.p95Ms}ms (24h, n=${m.h24.count})` }
  return { metric: null, detail: 'no traffic in 24h' }
}

{
  const started = Date.now()
  const secret = env('STATUS_METRICS_SECRET', true)
  let data = null, pending = '', failure = ''
  if (!secret) pending = 'skipped (no STATUS_METRICS_SECRET)'
  else {
    try {
      const r = await fetch(METRICS_URL, { headers: { Authorization: `Bearer ${secret}` } })
      if (r.status === 404 || r.status === 503) pending = `pending deploy (HTTP ${r.status})`
      else if (!r.ok) failure = `HTTP ${r.status}`
      else data = (await r.json()).metrics
    } catch (err) { failure = String(err?.message ?? err).slice(0, 160) }
  }
  const ms = Date.now() - started
  for (const [name, key] of [['lead-processing', 'leadProcessing'], ['lead-ping', 'leadPing']]) {
    if (data?.[key]) {
      const { metric, detail } = describeWindows(data[key])
      results.push({ name, ok: true, ms, metric, detail })
      console.log(`PASS ${name} (${ms}ms) — ${detail}`)
    } else if (failure) {
      results.push({ name, ok: false, ms, metric: null, detail: failure })
      console.error(`FAIL ${name} (${ms}ms) — ${failure}`)
    } else {
      results.push({ name, ok: true, ms, metric: null, detail: pending })
      console.log(`PASS ${name} (${ms}ms) — ${pending}`)
    }
  }
}

await probe('call-ping', async () => {
  // CALL_PING_URL is the complete ping URL (mode=availability&campaignId=…);
  // CALL_PING_KEY is a posting-scope API key for that campaign's tenant.
  // availability mode is contractually write-free, so a 15-min synthetic ping
  // is harmless; both accept and reject are HTTP 200 business outcomes — the
  // probe measures response time, not inventory.
  const url = env('CALL_PING_URL', true)
  const key = env('CALL_PING_KEY', true)
  if (!url || !key) return 'skipped (not configured)'
  const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j = await r.json().catch(() => null)
  if (!j || typeof j !== 'object') throw new Error('non-JSON response')
  return 'live round-trip OK'
}, 15_000)
{
  // For call-ping the round-trip IS the metric.
  const cp = results.find((r) => r.name === 'call-ping')
  if (cp) cp.metric = cp.ok && !String(cp.detail ?? '').startsWith('skipped') ? cp.ms : null
}

// ── SignalWire fabric control plane ─────────────────────────────────────────
let sat = ''
await probe('sw-token-mint', async () => {
  const r = await swFetch('/api/fabric/subscribers/tokens', {
    method: 'POST',
    body: JSON.stringify({ reference: CANARY_REF }),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const j = await r.json()
  if (!j.token) throw new Error('no token in response')
  sat = j.token
  return 'token minted'
})

await probe('sw-provision', async () => {
  // Resolve the canary subscriber's RESOURCE id (created implicitly by the mint;
  // eventually consistent, so retry briefly on first-ever run).
  let rid = ''
  for (let i = 0; i < 4 && !rid; i++) {
    if (i) await new Promise((res) => setTimeout(res, 1500))
    const r = await swFetch('/api/fabric/resources/subscribers?page_size=100')
    if (!r.ok) throw new Error(`resource list HTTP ${r.status}`)
    const j = await r.json()
    rid = (j.data ?? []).find((x) => x.display_name === CANARY_REF)?.id ?? ''
  }
  if (!rid) throw new Error('canary subscriber resource not found')

  // Stable name so a failed DELETE cannot mint a new leftover every 15 min
  // (unique `lr-canary-${timestamp}` grew without bound and can exhaust
  // product findInPages: MAX_PAGES=20). Sweep any lr-canary* first.
  const name = 'lr-canary-sip'
  {
    // Walk pages — first-page-only is the silent-miss this product already
    // paid for (findInPages). page_size=100 still misses leftovers on page 2+.
    let next = '/api/fabric/sip_addresses?page_size=50'
    for (let page = 0; page < 20 && next; page++) {
      const listed = await swFetch(next)
      if (!listed.ok) break
      const body = await listed.json()
      for (const row of body.data ?? []) {
        if (typeof row?.name === 'string' && row.name.startsWith('lr-canary') && row.id) {
          await swFetch(`/api/fabric/sip_addresses/${row.id}`, { method: 'DELETE' })
        }
      }
      const nxt = body.links?.next
      next = typeof nxt === 'string' && nxt.length ? nxt.replace(/^https?:\/\/[^/]+/, '') : ''
    }
  }
  // `user` is the SIP username, unique per domain. Omitting it lets SignalWire
  // default to `*`, which 422s `value_not_unique` ("User is already in use for
  // this domain") as soon as any other address exists on that domain — verified
  // staging 2026-08-21. The product path must send the same field.
  const create = await swFetch('/api/fabric/sip_addresses', {
    method: 'POST',
    body: JSON.stringify({ name, user: name, calling_handler_resource_id: rid }),
  })
  if (!create.ok) {
    const t = await create.text().catch(() => '')
    throw new Error(`create HTTP ${create.status}${t ? ': ' + t.slice(0, 160) : ''}`)
  }
  const made = await create.json()
  const del = await swFetch(`/api/fabric/sip_addresses/${made.id}`, { method: 'DELETE' })
  if (!del.ok && del.status !== 404) throw new Error(`created OK but delete HTTP ${del.status} (id ${made.id} may linger)`)
  return 'create+delete OK'
})

// ── real WebRTC registration in headless Chrome ─────────────────────────────
await probe('sw-webrtc-reg', async () => {
  if (process.env.SKIP_WEBRTC === '1') return 'skipped'
  if (!sat) throw new Error('no token from sw-token-mint')
  const { default: puppeteer } = await import('puppeteer-core')
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })
  // The SDK touches sessionStorage, which is denied on origin-less documents
  // (setContent/about:blank) — serve the harness from a real localhost origin.
  const { createServer } = await import('http')
  const html = `<!doctype html><script type="module">
      try {
        const m = await import('https://esm.sh/@signalwire/js@3.30.0')
        const c = await m.SignalWire({ token: ${JSON.stringify(sat)} })
        await c.online({ incomingCallHandlers: { all: () => {} } })
        console.log('[CANARY] OK')
      } catch (e) { console.log('[CANARY] FAIL: ' + ((e && e.message) || e)) }
    </script>`
  const server = createServer((_, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html) })
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  const port = server.address().port
  try {
    const page = await browser.newPage()
    const outcome = new Promise((resolve, reject) => {
      page.on('console', (m) => {
        const t = m.text()
        if (t.includes('[CANARY] OK')) resolve('registered')
        if (t.includes('[CANARY] FAIL')) reject(new Error(t.slice(0, 180)))
      })
    })
    await page.goto(`http://127.0.0.1:${port}/`)
    return await Promise.race([
      outcome,
      new Promise((_, rej) => setTimeout(() => rej(new Error('registration timed out (45s)')), 45_000)),
    ])
  } finally {
    await browser.close()
    server.close()
  }
}, 60_000)

// ── write result ────────────────────────────────────────────────────────────
const { writeFileSync, mkdirSync, readFileSync, existsSync } = await import('fs')
const fails = results.filter((r) => !r.ok).map((r) => r.name).sort()
const overall = fails.length === 0

// Alerting is TRANSITION-based, not state-based. The exit code drives the
// workflow's job failure, and GitHub emails on every failed run — so exiting 1
// while a KNOWN issue persists means an email every 15 minutes until it clears
// (62 in a row for the 08-18 sw-provision breakage), which trains the owner to
// ignore the canary. Exit 1 only when:
//   • the set of failing probes differs from the previous committed run
//     (something new broke, or the failure changed shape), or
//   • still degraded and >24h since the last alert (reminder — a long outage
//     must not go permanently silent).
// The status page gets every result regardless; a green Actions run therefore
// means "no NEW news", not "operational" — data/status.json is the truth.
// Previous state unreadable ⇒ treat as all-green, so a first run fails open.
let prev = {}
try { prev = JSON.parse(readFileSync('data/status.json', 'utf8')) } catch {}
const prevFails = (prev.checks ?? []).filter((c) => !c.ok).map((c) => c.name).sort()
const failSetChanged = JSON.stringify(fails) !== JSON.stringify(prevFails)
const lastAlertMs = prev.lastAlertAt ? Date.parse(prev.lastAlertAt) : 0
const reminderDue = !overall && Date.now() - lastAlertMs > 24 * 3600 * 1000
const alert = !overall && (failSetChanged || reminderDue)

const out = {
  generatedAt: now(),
  overall: overall ? 'operational' : 'degraded',
  // when the last email fired; cleared on recovery so a fresh incident always alerts
  lastAlertAt: overall ? null : (alert ? now() : prev.lastAlertAt ?? null),
  checks: results.map(({ name, ok, ms, detail, metric }) => ({ name, ok, ms, detail, ...(metric != null ? { metric } : {}) })),
}
mkdirSync('data', { recursive: true })
writeFileSync('data/status.json', JSON.stringify(out, null, 2))

// Rolling history (last 1344 runs ≈ 14 days at 15min) for the uptime strip
// and the latency-trend sparklines. `m` maps metric-probe name → ms for runs
// where the metric existed; absent otherwise, so old entries stay valid.
const histPath = 'data/history.json'
let hist = []
if (existsSync(histPath)) { try { hist = JSON.parse(readFileSync(histPath, 'utf8')) } catch {} }
const metricMap = Object.fromEntries(results.filter((r) => r.metric != null).map((r) => [r.name, r.metric]))
hist.push({ t: out.generatedAt, ok: overall, fails: results.filter((r) => !r.ok).map((r) => r.name), ...(Object.keys(metricMap).length ? { m: metricMap } : {}) })
writeFileSync(histPath, JSON.stringify(hist.slice(-1344)))

console.log(`\nOVERALL: ${out.overall.toUpperCase()}`)
if (!overall) {
  console.log(alert
    ? `ALERT: failing job — ${failSetChanged ? `failure set changed [${prevFails.join(', ') || 'none'}] → [${fails.join(', ')}]` : '24h reminder, still degraded'}`
    : `ALERT: suppressed — [${fails.join(', ')}] unchanged, last alerted ${out.lastAlertAt}`)
}
process.exit(alert ? 1 : 0)
