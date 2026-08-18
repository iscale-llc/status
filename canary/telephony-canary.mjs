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
 *
 * Output: data/status.json (current) — written by the workflow into the repo,
 * consumed by the GitHub Pages status page. NO secrets, ids, or URLs with
 * tokens ever go into the output.
 *
 * Env (all required unless noted):
 *   SW_PROJECT_ID, SW_API_TOKEN, SW_SPACE_HOST   — staging SignalWire project
 *   STAGING_HEALTH_URL, STAGING_BYPASS           — staging health through the SSO wall
 *   CHROME_PATH (optional)                       — headless Chrome binary
 *   SKIP_WEBRTC=1 (optional)                     — skip the browser probe
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

  const name = `lr-canary-${Date.now().toString(36)}`
  const create = await swFetch('/api/fabric/sip_addresses', {
    method: 'POST',
    body: JSON.stringify({ name, calling_handler_resource_id: rid }),
  })
  if (!create.ok) throw new Error(`create HTTP ${create.status}`)
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
  try {
    const page = await browser.newPage()
    const outcome = new Promise((resolve, reject) => {
      page.on('console', (m) => {
        const t = m.text()
        if (t.includes('[CANARY] OK')) resolve('registered')
        if (t.includes('[CANARY] FAIL')) reject(new Error(t.slice(0, 180)))
      })
    })
    await page.setContent(`<script type="module">
      try {
        const m = await import('https://esm.sh/@signalwire/js@3.30.0')
        const c = await m.SignalWire({ token: ${JSON.stringify(sat)} })
        await c.online({ incomingCallHandlers: { all: () => {} } })
        console.log('[CANARY] OK')
      } catch (e) { console.log('[CANARY] FAIL: ' + ((e && e.message) || e)) }
    </script>`)
    return await Promise.race([
      outcome,
      new Promise((_, rej) => setTimeout(() => rej(new Error('registration timed out (45s)')), 45_000)),
    ])
  } finally {
    await browser.close()
  }
}, 60_000)

// ── write result ────────────────────────────────────────────────────────────
const overall = results.every((r) => r.ok)
const out = {
  generatedAt: now(),
  overall: overall ? 'operational' : 'degraded',
  checks: results.map(({ name, ok, ms, detail }) => ({ name, ok, ms, detail })),
}
const { writeFileSync, mkdirSync, readFileSync, existsSync } = await import('fs')
mkdirSync('data', { recursive: true })
writeFileSync('data/status.json', JSON.stringify(out, null, 2))

// Rolling history (last 400 runs ≈ 4 days at 15min) for the uptime strip.
const histPath = 'data/history.json'
let hist = []
if (existsSync(histPath)) { try { hist = JSON.parse(readFileSync(histPath, 'utf8')) } catch {} }
hist.push({ t: out.generatedAt, ok: overall, fails: results.filter((r) => !r.ok).map((r) => r.name) })
writeFileSync(histPath, JSON.stringify(hist.slice(-400)))

console.log(`\nOVERALL: ${out.overall.toUpperCase()}`)
process.exit(overall ? 0 : 1)
