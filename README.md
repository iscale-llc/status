# Lead Router Status

Synthetic canary + public status page for theleadrouter.com.

- `canary/telephony-canary.mjs` — probes app health and the telephony provider control plane every 15 min (GitHub Actions, out-of-band from our hosting).
- `index.html` + `data/` — GitHub Pages status page (status.theleadrouter.com).

Born from the 2026-08-17 SignalWire Call Fabric incident, which was invisible on the provider status page for ~12 hours.
