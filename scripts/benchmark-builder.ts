#!/usr/bin/env bun
/**
 * Benchmark the LLM-driven builder across providers on the same prompt.
 *
 *   bun scripts/benchmark-builder.ts "a code review agent for TypeScript PRs"
 *
 * Runs each available provider (Ollama skipped if not running, Anthropic
 * skipped without ANTHROPIC_API_KEY), reports success / wall time / repairs.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarness } from "../src/builder";
import {
	createProvider,
	type ProviderConfig,
} from "../src/services/api/client";
import {
	checkOllamaRunning,
	detectOllamaConfig,
} from "../src/services/ollama/discovery";

const prompt =
	process.argv[2] ?? "an agent that reviews TypeScript pull requests";

interface BenchRow {
	provider: string;
	model: string;
	success: boolean;
	seconds: number;
	repairs: number;
	errors: string[];
}

async function candidates(): Promise<ProviderConfig[]> {
	const configs: ProviderConfig[] = [];

	if (process.env.OPENROUTER_API_KEY) {
		configs.push({
			type: "openrouter",
			model: process.env.BENCH_OPENROUTER_MODEL ?? "openai/gpt-oss-120b:free",
			apiKey: process.env.OPENROUTER_API_KEY,
			maxTokens: 8192,
		});
	}

	if (process.env.BENCH_SKIP_OLLAMA) {
		console.log("· Ollama skipped (BENCH_SKIP_OLLAMA)");
	} else if (await checkOllamaRunning()) {
		const detected = await detectOllamaConfig();
		const model = process.env.BENCH_OLLAMA_MODEL ?? detected?.model ?? "llama3";
		configs.push({
			type: "ollama",
			model,
			baseUrl: "http://localhost:11434",
			maxTokens: 4096,
			contextTokens: 8192,
		});
	} else {
		console.log("· Ollama not running — skipped");
	}

	if (process.env.ANTHROPIC_API_KEY) {
		configs.push({
			type: "anthropic",
			model: "claude-sonnet-5",
			apiKey: process.env.ANTHROPIC_API_KEY,
			maxTokens: 8192,
		});
	} else {
		console.log("· ANTHROPIC_API_KEY not set — anthropic skipped");
	}

	return configs;
}

async function bench(config: ProviderConfig): Promise<BenchRow> {
	const dir = await mkdtemp(join(tmpdir(), `bench-${config.type}-`));
	const started = performance.now();
	try {
		const result = await buildHarness(
			prompt,
			dir,
			(p) => console.log(`  [${config.type}] ${p.stage}: ${p.message}`),
			{ provider: createProvider(config), maxRepairs: 2 },
		);
		return {
			provider: config.type,
			model: config.model,
			success: result.success,
			seconds: Math.round((performance.now() - started) / 100) / 10,
			repairs: result.repairs ?? 0,
			errors: result.errors.map((e) => e.slice(0, 120)),
		};
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const configs = await candidates();
if (configs.length === 0) {
	console.error("No providers available to benchmark.");
	process.exit(1);
}

console.log(`\nBenchmarking builder on: "${prompt}"\n`);
const rows: BenchRow[] = [];
for (const config of configs) {
	console.log(`▶ ${config.type} (${config.model})`);
	rows.push(await bench(config));
}

console.log("\n┌─ RESULTS ─────────────────────────────────────────────");
for (const r of rows) {
	console.log(
		`│ ${r.success ? "✓" : "✗"} ${r.provider.padEnd(10)} ${r.model.padEnd(28)} ${String(r.seconds).padStart(6)}s  repairs=${r.repairs}`,
	);
	for (const e of r.errors) console.log(`│    error: ${e}`);
}
console.log("└───────────────────────────────────────────────────────");
