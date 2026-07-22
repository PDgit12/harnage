/**
 * harnage build-brain proxy — a thin Cloudflare Worker, not a general
 * gateway. Purpose: let `harnage init` generate a harness with ZERO user
 * setup (no API key, no local Ollama) by routing build-brain calls through
 * a self-hosted OmniRoute instance (https://github.com/diegosouzapw/OmniRoute)
 * — the real key never touches OpenRouter or any single provider directly;
 * OmniRoute itself aggregates 268+ providers (many free-tier) and this
 * Worker just forwards to it with OmniRoute's own issued key, injected
 * server-side.
 *
 * Security model:
 *   - OMNIROUTE_URL + OMNIROUTE_API_KEY live only as Worker secrets
 *     (wrangler secret put), never in source, never sent to the client.
 *   - Model allowlist is hardcoded to OmniRoute's documented zero-config
 *     routing strings only — this is NOT an open relay. A client cannot use
 *     this proxy to call arbitrary paid models on your OmniRoute account.
 *   - Client Authorization headers are ignored/stripped; the client sends a
 *     non-secret placeholder (OpenAI SDK requires a non-empty apiKey), this
 *     Worker injects the real OmniRoute key server-side before forwarding.
 *   - Rate limiting: configure a Cloudflare Rate Limiting rule on this route
 *     in the dashboard (Workers & Pages > this worker > Triggers > Rate
 *     limiting) — simplest, no code, no KV needed for v1. See DEPLOY.md.
 *
 * This proxy is build-brain-only. It has nothing to do with the runtime
 * model that powers a generated harness — that is always the end user's own
 * key or their own local Ollama, per harnage's two-brain architecture.
 *
 * OmniRoute itself must be deployed somewhere publicly reachable (a VPS via
 * its Docker image) — a laptop on localhost:20128 is not reachable from
 * Cloudflare's edge. See DEPLOY.md.
 */

// OmniRoute's documented zero-config routing strings (auto/<mode>). "cheap"
// is the closest documented match to "always prefer free/low-cost" — swap
// to "auto/offline" if you route through only local/free-tier providers.
const ALLOWED_MODELS = new Set(["auto/cheap", "auto"]);

export interface Env {
	OMNIROUTE_URL: string;
	OMNIROUTE_API_KEY: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders() });
		}
		if (request.method !== "POST") {
			return json({ error: "method not allowed" }, 405);
		}
		const url = new URL(request.url);
		if (url.pathname === "/health") {
			return json({ ok: true });
		}
		if (!url.pathname.endsWith("/chat/completions")) {
			return json({ error: "not found" }, 404);
		}

		let body: { model?: string; [k: string]: unknown };
		try {
			body = (await request.json()) as { model?: string; [k: string]: unknown };
		} catch {
			return json({ error: "invalid JSON body" }, 400);
		}

		if (!body.model || !ALLOWED_MODELS.has(body.model)) {
			return json(
				{
					error: `model not allowed by this shared build brain. Allowed: ${[...ALLOWED_MODELS].join(", ")}. Configure your own key in ~/.harnage/config.json to use any model.`,
				},
				403,
			);
		}

		if (!env.OMNIROUTE_URL || !env.OMNIROUTE_API_KEY) {
			return json(
				{ error: "proxy misconfigured: missing OmniRoute URL/key" },
				500,
			);
		}

		const upstream = await fetch(
			`${env.OMNIROUTE_URL.replace(/\/$/, "")}/api/v1/chat/completions`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${env.OMNIROUTE_API_KEY}`,
				},
				body: JSON.stringify(body),
			},
		);

		const headers = new Headers(upstream.headers);
		for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
		return new Response(upstream.body, {
			status: upstream.status,
			headers,
		});
	},
};

function corsHeaders(): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization",
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...corsHeaders() },
	});
}
