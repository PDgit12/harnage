# Deploying the harnage build-brain proxy

Two pieces: **OmniRoute** (holds real provider keys, does the actual model
routing/aggregation) and **this Cloudflare Worker** (the thin public
endpoint the CLI talks to — never sees a real provider key, only
OmniRoute's own issued key).

## 1. Deploy OmniRoute somewhere publicly reachable

OmniRoute must run on a host Cloudflare's edge can reach — **not** your
laptop's localhost. A small VPS (Fly.io, Railway, a $5 droplet, etc.) works:

```bash
docker run -d --name omniroute --restart unless-stopped --stop-timeout 40 \
  -p 20128:20128 -v omniroute-data:/app/data diegosouzapw/omniroute:latest
```

Open its dashboard (`http://<your-host>:20128`), connect at least one
free-tier provider, and generate an API key (Dashboard → Endpoints).

## 2. Deploy the Worker

```bash
cd infra/harnage-proxy
npx wrangler login
npx wrangler secret put OMNIROUTE_URL       # e.g. http://<your-host>:20128
npx wrangler secret put OMNIROUTE_API_KEY   # the key from OmniRoute's dashboard
npx wrangler deploy
```

Wrangler prints your Worker URL, e.g. `https://harnage-proxy.<you>.workers.dev`.

## 3. Set a rate limit (dashboard, no code)

Cloudflare dashboard → Workers & Pages → harnage-proxy → Triggers → Rate
limiting → add a rule (e.g. 20 req/min per IP). The model allowlist in
worker.ts stops arbitrary-model abuse; this stops volume abuse.

## 4. Point the CLI at it

```bash
export HARNAGE_PROXY_URL="https://harnage-proxy.<you>.workers.dev"
```

`resolveProvider()` probes `$HARNAGE_PROXY_URL/health` before using it as a
build-brain fallback — dead or unset proxy just falls through to the
existing offline keyword builder, never blocks a build.

## Rotating / killing access

Re-run `wrangler secret put OMNIROUTE_API_KEY` to rotate. Revoke the key in
OmniRoute's own dashboard to kill access without touching the Worker at all.
`wrangler delete` kills the whole public endpoint.
