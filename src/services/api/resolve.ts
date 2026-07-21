import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "./client";

export const CONFIG_DIR = join(homedir(), ".harnage");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/**
 * Shared, zero-setup build brain: a Cloudflare Worker (infra/harnage-proxy)
 * that forwards to a self-hosted OmniRoute instance
 * (https://github.com/diegosouzapw/OmniRoute), which holds real provider
 * keys server-side and aggregates free-tier models. Lets `harnage init` work
 * immediately after install with no user API key and no local Ollama — this
 * project has no billing infra, so this is the "free tier" until it does.
 * Never used for a generated harness's runtime model (always the end user's
 * own key or local Ollama) — this constant is read only by resolveProvider(),
 * which is exclusively a build-brain resolver (see its callers: main.tsx
 * init, studio.ts, commands/init).
 */
const DEFAULT_PROXY_URL = process.env.HARNAGE_PROXY_URL ?? "";
// OmniRoute's zero-config "prefer cheap/free" routing string — see
// infra/harnage-proxy/worker.ts for the full allowlist this must match.
const PROXY_MODEL = "auto/cheap";

async function probeSharedProxy(): Promise<ProviderConfig | null> {
	if (!DEFAULT_PROXY_URL) return null;
	try {
		const res = await fetch(`${DEFAULT_PROXY_URL}/health`, {
			signal: AbortSignal.timeout(1500),
		});
		if (!res.ok) return null;
	} catch {
		return null;
	}
	return {
		type: "openai",
		model: PROXY_MODEL,
		// Placeholder — the OpenAI SDK requires a non-empty key, the proxy
		// ignores it and injects the real key server-side.
		apiKey: "harnage-shared-build-brain",
		baseUrl: DEFAULT_PROXY_URL,
		maxTokens: 8192,
	};
}

/**
 * Resolve a provider config without user interaction:
 * saved config → ANTHROPIC_API_KEY → OPENAI_API_KEY → OPENROUTER_API_KEY →
 * running Ollama → shared zero-setup proxy (if configured + reachable) →
 * llama3 fallback. Any OpenAI-compatible aggregator (OpenRouter, ZenMux, …)
 * works via a saved config with type "openai"/"openrouter" and a baseUrl.
 */
export async function resolveProvider(): Promise<ProviderConfig> {
	if (existsSync(CONFIG_PATH)) {
		try {
			const raw = readFileSync(CONFIG_PATH, "utf-8");
			return JSON.parse(raw) as ProviderConfig;
		} catch (e) {
			console.warn(
				`Failed to parse config at ${CONFIG_PATH}:`,
				(e as Error).message,
			);
		}
	}
	if (process.env.ANTHROPIC_API_KEY)
		return {
			type: "anthropic",
			model: "claude-sonnet-5",
			apiKey: process.env.ANTHROPIC_API_KEY,
			maxTokens: 8192,
		};
	if (process.env.OPENAI_API_KEY)
		return {
			type: "openai",
			model: "gpt-4o",
			apiKey: process.env.OPENAI_API_KEY,
			maxTokens: 8192,
		};
	// OpenRouter — one key, many model APIs (Anthropic/OpenAI/Google/poolside/…).
	// Set OPENROUTER_MODEL to pick (e.g. poolside/laguna-m.1:free).
	if (process.env.OPENROUTER_API_KEY)
		return {
			type: "openrouter",
			model: process.env.OPENROUTER_MODEL ?? "anthropic/claude-3.5-sonnet",
			apiKey: process.env.OPENROUTER_API_KEY,
			baseUrl: "https://openrouter.ai/api/v1",
			maxTokens: 8192,
		};

	const { checkOllamaRunning, detectOllamaConfig } = await import(
		"../ollama/discovery"
	);
	if (await checkOllamaRunning()) {
		const config = await detectOllamaConfig();
		if (config) return config;
	}

	const proxied = await probeSharedProxy();
	if (proxied) return proxied;

	return {
		type: "ollama",
		model: "llama3",
		baseUrl: "http://localhost:11434",
		maxTokens: 4096,
	};
}
