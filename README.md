# Lead Router Status

Synthetic canary + public status page for theleadrouter.com.

- `canary/telephony-canary.mjs` — probes app health and the telephony provider control plane every 15 min (GitHub Actions, out-of-band from our hosting).
- `index.html` + `data/` — GitHub Pages status page (status.theleadrouter.com).

## Business latency metrics (2026-08-20)

Three metric rows track intake latency over time (trend sparklines on the page):

| Row | Source |
|---|---|
| Lead processing — ingest → decision | real-traffic avg/p95 from `GET theleadrouter.com/api/public/status-latency` (Bearer `STATUS_METRICS_SECRET` Actions secret; aggregates `postingLog.durationMs`) |
| Lead ping → price return | same endpoint, `/api/v1/leads/ping` traffic |
| Call ping → response | a REAL `mode=availability` call-RTB ping every run (write-free by that route's contract); RTT is the metric |

Config: `STATUS_METRICS_SECRET` (also in the "Lead Router - Staging" 1Password vault),
`CALL_PING_URL` (full ping URL incl. `mode=availability&campaignId=…`), `CALL_PING_KEY`
(posting-scope API key). Unset call-ping secrets → the row shows "skipped (not configured)".
Quiet traffic and a not-yet-deployed endpoint render as informational, never as outages.

Born from the 2026-08-17 SignalWire Call Fabric incident, which was invisible on the provider status page for ~12 hours.
