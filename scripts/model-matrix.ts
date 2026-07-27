#!/usr/bin/env bun
import { paramsOf } from "../src/builder/models/catalog";
/**
 * MODEL MATRIX — characterize every installed local model in one pass.
 *
 *   bun scripts/model-matrix.ts                 # every installed Ollama model
 *   bun scripts/model-matrix.ts qwen2.5:3b llama3:latest
 *
 * Why this exists: the scaffold a generated harness ships with is chosen from a
 * parameter count, and a parameter count is a poor predictor. A measured A/B on
 * qwen2.5:3b put constrained-json at 14/20 against native tool-calling at 7/20
 * — the size tier would have handed a slightly larger sibling the worse of the
 * two. The only way to know a band is right is to measure a model in it.
 *
 * This prints, per model, the tier the harness WOULD assign, what the probes
 * actually found, and the overrides measurement forces on top. Rows where the
 * tier and the measurement disagree are the ones worth acting on.
 *
 * Cheap: three one-turn probes per model, a couple of seconds on a 3B. Nothing
 * here executes a battery — see scripts/eval.ts for that.
 */
import { characterizeModel } from "../src/builder/models/characterize";
import { createProvider } from "../src/services/api/client";

const baseUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";

/** Models that cannot drive a tool loop — embeddings, vision-only. */
const NOT_AGENTIC = /embed|clip|llava|bakllava|moondream|whisper/i;

async function installedModels(): Promise<string[]> {
	const res = await fetch(`${baseUrl}/api/tags`, {
		signal: AbortSignal.timeout(4000),
	});
	const { models } = (await res.json()) as { models?: Array<{ name: string }> };
	return (models ?? []).map((m) => m.name).filter((n) => !NOT_AGENTIC.test(n));
}

/** Mirrors resolveBase() in the generated engine — the tier a build assigns
 *  from the name alone, before anything is measured. */
function assignedTier(model: string): string {
	const m = model.toLowerCase();
	if (/claude|gpt-4|gpt-5|o1|o3|gemini/.test(m)) return "frontier";
	// Shared with the builder and the generated engine — a local copy here would
	// drift, which is exactly why llama3:latest reported "unknown size" after the
	// size table was added.
	const size = paramsOf(model);
	if (size >= 13) return "strong";
	if ((size > 0 && size <= 3.5) || /phi|tinyllama|gemma:2b|llama3\.2/.test(m))
		return "small";
	if (size > 0 && size <= 6) return "small+";
	if (size > 0 && size <= 9) return "mid";
	if (size > 0 && size < 13) return "mid+";
	return "mid (unknown size)";
}

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
let models: string[];
try {
	models = args.length ? args : await installedModels();
} catch {
	console.error(`Could not reach Ollama at ${baseUrl}. Is it running?`);
	process.exit(1);
}

if (!models.length) {
	console.error("No agentic models installed. Try: ollama pull qwen2.5:3b");
	process.exit(1);
}

console.log(`Characterizing ${models.length} model(s) via ${baseUrl}\n`);
console.log(
	`${"model".padEnd(24)}${"tier".padEnd(20)}${"json".padEnd(7)}${"paths".padEnd(8)}${"acts".padEnd(7)}${"s/turn".padEnd(9)}overrides`,
);
console.log("─".repeat(104));

interface Row {
	model: string;
	tier: string;
	json: boolean;
	paths: boolean;
	acts: boolean;
	sec: number;
	overrides: string[];
	reachable: boolean;
}
const rows: Row[] = [];

for (const model of models) {
	const provider = createProvider({
		type: "ollama",
		model,
		baseUrl,
		maxTokens: 512,
		contextTokens: 8192,
	});
	const c = await characterizeModel(provider);
	const tier = assignedTier(model);
	const overrides = Object.keys(c.override);
	const mark = (b: boolean) => (b ? "ok" : "WEAK");
	rows.push({
		model,
		tier,
		json: c.json,
		paths: c.pathFidelity,
		acts: c.acts,
		sec: Math.round(c.medianMs / 100) / 10,
		overrides,
		reachable: c.completed > 0,
	});
	console.log(
		`${model.padEnd(24)}${tier.padEnd(20)}${mark(c.json).padEnd(7)}${mark(c.pathFidelity).padEnd(8)}${mark(c.acts).padEnd(7)}${String(rows[rows.length - 1].sec).padEnd(9)}${overrides.length ? overrides.join(",") : "—"}`,
	);
}

// ── Findings ────────────────────────────────────────────────────────────────
console.log();
const unreachable = rows.filter((r) => !r.reachable);
if (unreachable.length) {
	console.log(
		`Unreachable (no verdict, size tier stands): ${unreachable.map((r) => r.model).join(", ")}`,
	);
}

const reachable = rows.filter((r) => r.reachable);
const needWork = reachable.filter((r) => r.overrides.length);
console.log(
	`${reachable.length - needWork.length}/${reachable.length} model(s) need no scaffold change; ${needWork.length} are tuned by measurement.`,
);

// The rows that matter: a model the size tier calls capable, that measurably
// is not. These are where a parameter count would have shipped a worse harness.
const overRated = reachable.filter(
	(r) =>
		(r.tier === "strong" || r.tier.startsWith("mid")) && (!r.acts || !r.json),
);
if (overRated.length) {
	console.log(
		`\nTIER DISAGREES WITH MEASUREMENT — the size tier rates these higher than they behave:`,
	);
	for (const r of overRated) {
		const weak = [!r.json && "json", !r.paths && "paths", !r.acts && "acts"]
			.filter(Boolean)
			.join(", ");
		console.log(`  ${r.model} (${r.tier}) is weak at: ${weak}`);
	}
}

const slow = reachable.filter((r) => r.sec > 10);
if (slow.length) {
	console.log(
		`\nSlow endpoints (>10s/turn), expect long runs: ${slow.map((r) => `${r.model} ${r.sec}s`).join(", ")}`,
	);
}
console.log();
