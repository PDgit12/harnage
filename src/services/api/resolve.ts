import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "./client";

export const CONFIG_DIR = join(homedir(), ".harnage");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/**
 * Resolve a provider config without user interaction:
 * saved config → ANTHROPIC_API_KEY → OPENAI_API_KEY → running Ollama →
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

	return {
		type: "ollama",
		model: "llama3",
		baseUrl: "http://localhost:11434",
		maxTokens: 4096,
	};
}
