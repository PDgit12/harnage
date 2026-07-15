import { AnthropicProvider } from "./providers/AnthropicProvider";
import { OllamaProvider } from "./providers/OllamaProvider";
import { OpenAIProvider } from "./providers/OpenAIProvider";
import type { StreamEvent } from "./types";

export interface ProviderConfig {
	type: "anthropic" | "openai" | "ollama" | "openrouter";
	apiKey?: string;
	baseUrl?: string;
	model: string;
	maxTokens: number;
	/** Context window size (Ollama num_ctx). Distinct from maxTokens, which bounds output. */
	contextTokens?: number;
	/** Build-brain resilience: models to try (same provider/key) if the primary
	 * fails — free OpenRouter tiers are rate-limited, so one 429 shouldn't drop
	 * a build to the keyword fallback. Only used by createBuildProvider. */
	fallbackModels?: string[];
}

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface Provider {
	stream(
		messages: Array<{ role: string; content: string }>,
		tools?: ToolDefinition[],
		/** JSON schema to constrain the reply (OpenAI-compatible response_format). */
		responseFormat?: Record<string, unknown>,
	): AsyncGenerator<StreamEvent>;
}

export function createProvider(config: ProviderConfig): Provider {
	switch (config.type) {
		case "anthropic":
			return new AnthropicProvider(config);
		case "openai":
			return new OpenAIProvider(config);
		case "openrouter":
			return new OpenAIProvider({
				...config,
				baseUrl: config.baseUrl || "https://openrouter.ai/api/v1",
			});
		case "ollama":
			return new OllamaProvider(config);
	}
}

/**
 * Model-fallback wrapper for the BUILD brain only. Tries the primary model,
 * then each fallback (same provider + key), moving on when a model yields no
 * text (429 / provider error) before committing. It buffers each attempt, so
 * it is NOT for runtime token streaming — build-brain calls collect the full
 * reply anyway (completeJSON). With no fallbacks it is a plain provider.
 */
class FallbackProvider implements Provider {
	private configs: ProviderConfig[];
	constructor(config: ProviderConfig) {
		const { fallbackModels, ...base } = config;
		this.configs = [
			base,
			...(fallbackModels ?? []).map((model) => ({ ...base, model })),
		];
	}

	async *stream(
		messages: Array<{ role: string; content: string }>,
		tools?: ToolDefinition[],
		responseFormat?: Record<string, unknown>,
	): AsyncGenerator<StreamEvent> {
		let lastError = "no build-brain model responded";
		for (const cfg of this.configs) {
			const provider = createProvider(cfg);
			const buffer: StreamEvent[] = [];
			let hasText = false;
			let failed = false;
			try {
				for await (const ev of provider.stream(
					messages,
					tools,
					responseFormat,
				)) {
					if (ev.type === "error" && !hasText) {
						lastError = ev.content ?? "provider error";
						failed = true;
						break;
					}
					if (ev.type === "text" && ev.content) hasText = true;
					buffer.push(ev);
				}
			} catch (err) {
				if (hasText) throw err; // failed mid-reply — don't silently switch models
				lastError = err instanceof Error ? err.message : String(err);
				failed = true;
			}
			if (!failed && hasText) {
				for (const ev of buffer) yield ev;
				return;
			}
		}
		yield {
			type: "error",
			content: `all build-brain models failed: ${lastError}`,
		};
	}
}

/**
 * Provider for the build brain. Adds model-fallback when config.fallbackModels
 * is set; otherwise identical to createProvider. Use this for init/studio's
 * build stages, never for the runtime agent.
 */
export function createBuildProvider(config: ProviderConfig): Provider {
	if (config.fallbackModels?.length) return new FallbackProvider(config);
	return createProvider(config);
}
