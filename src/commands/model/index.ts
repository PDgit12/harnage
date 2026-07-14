import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalCommandHandler } from "../../commands";
import { listOllamaModels } from "../../services/ollama/discovery";

const CONFIG_PATH = join(homedir(), ".harnage", "config.json");

interface ProviderConfig {
	type: "anthropic" | "openai" | "ollama" | "openrouter";
	model: string;
	apiKey?: string;
	baseUrl?: string;
	maxTokens: number;
}

function loadConfig(): ProviderConfig | null {
	if (!existsSync(CONFIG_PATH)) return null;
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as ProviderConfig;
	} catch {
		return null;
	}
}

function saveConfig(c: ProviderConfig): void {
	mkdirSync(join(homedir(), ".harnage"), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}

const VALID_MODELS = [
	"claude-sonnet-5",
	"gpt-4o",
	"gpt-4o-mini",
	"ollama/llama3",
	"ollama/mistral",
];

function stripOllamaPrefix(name: string): string {
	return name.replace(/^ollama\//, "");
}

async function suggestOllamaModels(): Promise<string[]> {
	try {
		const models = await listOllamaModels();
		return models.length > 0 ? models.map((m) => `ollama/${m}`) : [];
	} catch {
		return [];
	}
}

const handler: LocalCommandHandler = {
	async call(args: string[]): Promise<{ value: string }> {
		const config = loadConfig();
		const current = config?.model ?? "unknown";

		if (args.length === 0) {
			const ollamaModels = current.startsWith("ollama/")
				? await suggestOllamaModels()
				: [];
			let msg = `Current model: ${current}`;
			if (ollamaModels.length > 0) {
				msg += `\nAvailable Ollama models: ${ollamaModels.join(", ")}`;
			} else if (current.startsWith("ollama/")) {
				msg += `\n${stripOllamaPrefix(current)} not found locally. Pull it: ollama pull ${stripOllamaPrefix(current)}`;
			}
			return { value: msg };
		}

		const requested = args.join(" ");
		const match = VALID_MODELS.find((m) => m.includes(requested));

		if (match && config) {
			config.model = match;
			saveConfig(config);
			return { value: `Switched to: ${match}` };
		}

		const ollamaModels = await suggestOllamaModels();
		const allOptions = [...VALID_MODELS, ...ollamaModels];
		const ollamaMatch = allOptions.find((m) => m.includes(requested));
		if (ollamaMatch && config) {
			config.model = ollamaMatch;
			saveConfig(config);
			const name = stripOllamaPrefix(ollamaMatch);
			const existsLocally = ollamaModels.some(
				(m) => m === ollamaMatch || m.endsWith(`/${name}`),
			);
			if (!existsLocally)
				return {
					value: `Switched to: ${ollamaMatch}\nModel not pulled yet. Run: ollama pull ${name}`,
				};
			return { value: `Switched to: ${ollamaMatch}` };
		}

		const suggestions = allOptions
			.filter((m) => m.toLowerCase().includes(requested.toLowerCase()))
			.slice(0, 5);
		let msg = `Unknown model: ${requested}.\nValid options: ${VALID_MODELS.join(", ")}`;
		if (suggestions.length > 0)
			msg += `\nDid you mean: ${suggestions.join(", ")}`;
		return { value: msg };
	},
};

export default handler;
