import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { GLYPHS, gradientWordmark, TAGLINE, VERSION } from "./ui/brand";

export interface ProviderConfig {
	type: "anthropic" | "openai" | "ollama" | "openrouter";
	model: string;
	apiKey?: string;
	baseUrl?: string;
	maxTokens: number;
}

const DEFAULT_MODELS: Record<string, string> = {
	anthropic: "claude-sonnet-5",
	openai: "gpt-4o",
	ollama: "llama3",
	openrouter: "gpt-4o",
};

export async function setupWizard(): Promise<ProviderConfig> {
	const rl = createInterface({ input, output });

	console.log(`${GLYPHS.gear} ${gradientWordmark()}  ${chalk.dim(VERSION)}`);
	console.log(chalk.dim(TAGLINE));
	console.log(chalk.dim("Welcome! Let's set up your provider."));
	console.log("");

	const providerChoice = await rl.question(
		chalk.dim(
			"Select provider (1=Anthropic, 2=OpenAI, 3=Ollama, 4=OpenRouter): ",
		),
	);
	rl.close();

	type ProviderType = ProviderConfig["type"];
	const providerMap: Record<string, ProviderType> = {
		"1": "anthropic",
		"2": "openai",
		"3": "ollama",
		"4": "openrouter",
	};
	const type = providerMap[providerChoice.trim()];
	if (!type) {
		console.log(chalk.yellow(`  Unrecognized choice, defaulting to Ollama.`));
	}
	const resolvedType = type ?? "ollama";

	const config: ProviderConfig = {
		type: resolvedType,
		model: DEFAULT_MODELS[resolvedType] ?? "llama3",
		maxTokens: resolvedType === "ollama" ? 4096 : 8192,
	};

	if (resolvedType === "ollama") {
		config.baseUrl = "http://localhost:11434";
	} else if (resolvedType === "openrouter") {
		config.baseUrl = "https://openrouter.ai/api/v1";
	}

	const rl2 = createInterface({ input, output });

	if (resolvedType !== "ollama") {
		const apiKey = await rl2.question(
			chalk.dim(`API key for ${resolvedType}: `),
		);
		if (apiKey.trim()) config.apiKey = apiKey.trim();
	}

	if (resolvedType === "ollama" || resolvedType === "openrouter") {
		const baseUrl = await rl2.question(
			chalk.dim(`Base URL [${config.baseUrl}]: `),
		);
		if (baseUrl.trim()) config.baseUrl = baseUrl.trim();
	}

	const model = await rl2.question(chalk.dim(`Model [${config.model}]: `));
	if (model.trim()) config.model = model.trim();

	rl2.close();

	const configDir = join(homedir(), ".harnage");
	await mkdir(configDir, { recursive: true });
	await writeFile(
		join(configDir, "config.json"),
		JSON.stringify(config, null, 2),
	);

	console.log(chalk.green(`${GLYPHS.check} Configuration saved.`));

	return config;
}
