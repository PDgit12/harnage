/**
 * Model catalog — a RECOMMENDATION layer, not a whitelist.
 *
 * Layer 1: a small curated shortlist of proven best-in-class local models across
 *          the (work-type × size) grid. Reality is concentrated — a handful of
 *          families (Qwen dominates local tool-calling) covers most users.
 * Layer 2: family/variant/size inference for ANY model not in the shortlist, so
 *          the infinite long tail still gets a sensible profile. Nothing is
 *          excluded — the catalog makes the good choice easy; inference makes
 *          every choice viable.
 *
 * Only real, pullable Ollama model IDs appear here — a recommendation the user
 * can act on with `ollama pull <id>`.
 */

export type WorkType = "code" | "data" | "docs" | "review" | "general";

/**
 * Per-model scaffold curation baked into the generated harness on top of the
 * size-tier default — so two same-size models are tuned differently (a coder
 * gets precise edits; a proven native tool-caller gets the free loop). Mirrors
 * the generated ModelProfile fields; all optional.
 */
export interface ProfileOverride {
	loop?: "free" | "plan-act" | "pipeline";
	toolCalling?: "native" | "constrained-json";
	maxTools?: number;
	editFormat?: "search-replace" | "whole-file";
	systemPromptBudget?: number;
	temperature?: number;
	repeatPenalty?: number;
	nudge?: boolean;
}

export interface CatalogEntry {
	/** Ollama model id — must be pullable as-is. */
	id: string;
	/** Parameter count in billions (active params for MoE). */
	params: number;
	/** Rough RAM needed to run comfortably at Q4, in GB. */
	ramGb: number;
	/** Work types this model is a strong pick for. */
	domains: WorkType[];
	/** One-line rationale shown to the user. */
	note: string;
	license: string;
	/** Scaffold tuning specific to this model, baked into profiles.ts at build. */
	profileOverrides?: ProfileOverride;
}

// Curated shortlist. Qwen-heavy on purpose: it leads practical local tool-calling
// at every size, and Apache-2.0 suits sovereign/regulated buyers.
export const CATALOG: CatalogEntry[] = [
	{
		id: "qwen2.5:0.5b",
		params: 0.5,
		ramGb: 1,
		domains: ["general"],
		note: "Smallest tool-capable model — for very constrained boxes",
		license: "Apache-2.0",
	},
	{
		id: "llama3.2:1b",
		params: 1,
		ramGb: 1,
		domains: ["general"],
		note: "Tiny Llama — runs anywhere, best for simple single-step agents",
		license: "Llama-3.2",
	},
	{
		id: "llama3.2:3b",
		params: 3,
		ramGb: 2,
		domains: ["general", "docs"],
		note: "Small Llama — stronger prose than same-size peers",
		license: "Llama-3.2",
	},
	{
		id: "gemma2:2b",
		params: 2,
		ramGb: 2,
		domains: ["general", "docs"],
		note: "Google's small model — good summarisation for its size",
		license: "Gemma",
	},
	{
		id: "phi3:3.8b",
		params: 3.8,
		ramGb: 3,
		domains: ["general", "review"],
		note: "Microsoft Phi — reasoning-dense for 3.8B, MIT licensed",
		license: "MIT",
	},
	{
		id: "qwen2.5:3b",
		params: 3,
		ramGb: 3,
		domains: ["general", "data", "docs"],
		note: "Fast, reliable tool-calling at a tiny size",
		license: "Apache-2.0",
	},
	{
		id: "qwen2.5-coder:3b",
		params: 3,
		ramGb: 3,
		domains: ["code", "review"],
		note: "Code-specialized at 3B — cheapest real coder",
		license: "Apache-2.0",
		profileOverrides: { editFormat: "search-replace", temperature: 0 },
	},
	{
		id: "qwen2.5-coder:7b",
		params: 7,
		ramGb: 5,
		domains: ["code", "review"],
		note: "Best code reasoning that fits 8GB",
		license: "Apache-2.0",
		// A tuned coder does precise search/replace edits at temperature 0.
		profileOverrides: { editFormat: "search-replace", temperature: 0 },
	},
	{
		id: "qwen3:8b",
		params: 8,
		ramGb: 6,
		domains: ["general", "code", "data", "docs", "review"],
		note: "Best all-round local agent — native tool-calling",
		license: "Apache-2.0",
		// Proven reliable native tool-caller at 8B — earn the free loop instead of
		// the safe mid-tier constrained default (curated per-model upgrade).
		profileOverrides: {
			loop: "free",
			toolCalling: "native",
			maxTools: 8,
			nudge: true,
		},
	},
	{
		id: "llama3.1:8b",
		params: 8,
		ramGb: 5,
		domains: ["general", "docs"],
		note: "Solid general-purpose, broad knowledge",
		license: "Llama-3.1",
	},
	{
		id: "mistral:7b",
		params: 7,
		ramGb: 4,
		domains: ["general"],
		note: "Lightweight general model, fast",
		license: "Apache-2.0",
	},
	{
		id: "gemma2:9b",
		params: 9,
		ramGb: 6,
		domains: ["general", "docs"],
		note: "Strong prose/summarization",
		license: "Gemma",
	},
	{
		id: "deepseek-r1:8b",
		params: 8,
		ramGb: 5,
		domains: ["review", "data"],
		note: "Step-by-step reasoning — good for analysis/review",
		license: "MIT",
		// A reasoning model needs room to think and a little sampling warmth.
		profileOverrides: { systemPromptBudget: 3200, temperature: 0.3 },
	},
	{
		id: "granite3.1-dense:8b",
		params: 8,
		ramGb: 5,
		domains: ["general", "code", "review"],
		note: "IBM Granite — explicitly tool/function-tuned, Apache-2.0",
		license: "Apache-2.0",
	},
	{
		id: "codegemma:7b",
		params: 7,
		ramGb: 5,
		domains: ["code"],
		note: "Google's code model — solid completion and edits",
		license: "Gemma",
		profileOverrides: { editFormat: "search-replace", temperature: 0 },
	},
	{
		id: "mistral-nemo:12b",
		params: 12,
		ramGb: 8,
		domains: ["general", "docs", "data"],
		note: "Mistral/NVIDIA 12B — long context, strong general agent",
		license: "Apache-2.0",
	},
	{
		id: "phi4:14b",
		params: 14,
		ramGb: 9,
		domains: ["review", "data", "general"],
		note: "Phi-4 — strong reasoning per parameter, MIT licensed",
		license: "MIT",
	},
	{
		id: "qwen2.5:14b",
		params: 14,
		ramGb: 9,
		domains: ["general", "data", "review"],
		note: "Strong general model when you have 32GB",
		license: "Apache-2.0",
	},
	{
		id: "qwen2.5-coder:14b",
		params: 14,
		ramGb: 9,
		domains: ["code", "review"],
		note: "Strongest dense coder for 16–32GB",
		license: "Apache-2.0",
		profileOverrides: { editFormat: "search-replace", temperature: 0 },
	},
	{
		id: "deepseek-coder-v2:16b",
		params: 16,
		ramGb: 9,
		domains: ["code", "review"],
		note: "Code-focused MoE — strong at completion",
		license: "DeepSeek",
	},
	{
		id: "qwen3-coder:30b",
		params: 30,
		ramGb: 19,
		domains: ["code", "review"],
		note: "Best local coder overall (MoE) — needs 24GB+",
		license: "Apache-2.0",
	},
	{
		id: "llama3.3:70b",
		params: 70,
		ramGb: 40,
		domains: ["general", "code", "data", "review", "docs"],
		note: "Frontier-class local model — needs a 64GB+ box",
		license: "Llama-3.3",
	},
	{
		id: "qwen2.5:32b",
		params: 32,
		ramGb: 20,
		domains: ["general", "data"],
		note: "Top general model for high-RAM boxes",
		license: "Apache-2.0",
	},
];

/** RAM ceiling on parameter count — mirrors the runtime speed-first caps. */
export function maxParamsForRam(ramGb: number): number {
	if (ramGb >= 96) return 70;
	if (ramGb >= 64) return 33;
	if (ramGb >= 32) return 14;
	if (ramGb >= 16) return 8;
	return 4;
}

/** Map an agent description to a primary work type (keyword heuristic). */
export function classifyDomain(text: string): WorkType {
	const t = text.toLowerCase();
	if (/\breview|\bpr\b|diff|lint|audit|refactor/.test(t)) return "review";
	if (/\bcode|program|typescript|python|repo|codebase|compile|function/.test(t))
		return "code";
	if (/\bcsv|data|rows|dataset|dedup|etl|table|sql|clean/.test(t))
		return "data";
	if (/\bdoc|markdown|readme|wiki|write-up|summar/.test(t)) return "docs";
	return "general";
}

// Every harness ships the full kit. Withholding tools by domain looks like
// specialisation but is really guesswork: an "n8n automation" prompt classifies
// as general, and dropping bash/web_fetch left it with no way to reach an HTTP
// endpoint at all. Capability is cheap to ship and expensive to be missing.
//
// Specialisation lives in how the tools are SELECTED, PRESENTED and RANKED per
// task — see domainToolPriority below and selectTools in the generated engine.
export const BASELINE_TOOLS = [
	"bash",
	"file_read",
	"file_write",
	"file_edit",
	"glob",
	"grep",
];

/**
 * Which tools a domain reaches for FIRST. The generated engine can only expose
 * `profile.maxTools` per turn (small models' tool-call accuracy collapses past
 * ~5-8), so on a tight budget the ordering decides what the model can even see.
 * A docs agent should get grep before bash; a code agent the reverse.
 *
 * Ordering only — nothing is removed. Anything not listed keeps its existing
 * goal-relevance ranking behind these.
 */
export function domainToolPriority(domain: WorkType): string[] {
	switch (domain) {
		case "code":
			return ["file_read", "bash", "grep", "glob", "file_edit", "file_write"];
		case "review":
			return ["file_read", "grep", "bash", "glob", "file_edit", "file_write"];
		case "data":
			return ["file_read", "glob", "bash", "file_write", "grep", "file_edit"];
		case "docs":
			return ["file_read", "grep", "glob", "file_write", "web_fetch", "bash"];
		default:
			return ["file_read", "file_write", "web_fetch", "bash", "glob", "grep"];
	}
}

export interface FamilyInfo {
	params: number;
	family: string;
	isCoder: boolean;
	toolTuned: boolean;
}

/** Layer 2: infer capability signals from a model id we don't have curated. */
/**
 * Parameter counts for models whose tag carries no size — `llama3:latest`,
 * `mistral`, a bare `gemma2`. `:latest` is how most people actually pull a
 * model, and without this every one of them lands on the generic
 * unknown-size default instead of its real band. Values are the size Ollama
 * ships for the untagged/`:latest` variant.
 */
export const DEFAULT_PARAMS: Array<[RegExp, number]> = [
	[/^llama3\.2(:latest)?$/, 3],
	[/^llama3\.1(:latest)?$/, 8],
	[/^llama3(:latest)?$/, 8],
	[/^llama2(:latest)?$/, 7],
	[/^codellama(:latest)?$/, 7],
	[/^qwen2\.5-coder(:latest)?$/, 7],
	[/^qwen2\.5(:latest)?$/, 7],
	[/^qwen3(:latest)?$/, 8],
	[/^mistral(:latest)?$/, 7],
	[/^mistral-nemo(:latest)?$/, 12],
	[/^mixtral(:latest)?$/, 47],
	[/^gemma2(:latest)?$/, 9],
	[/^gemma(:latest)?$/, 7],
	[/^phi3(:latest)?$/, 3.8],
	[/^phi4(:latest)?$/, 14],
	[/^deepseek-r1(:latest)?$/, 7],
	[/^deepseek-coder(:latest)?$/, 6.7],
	[/^granite3\.?\d*(:latest)?$/, 8],
	[/^command-r(:latest)?$/, 35],
];

/** Parameter count in billions, from the tag or the known-defaults table. */
export function paramsOf(id: string): number {
	const lower = id.toLowerCase();
	const tagged = Number.parseFloat(
		lower.match(/(\d+(?:\.\d+)?)b\b/)?.[1] ?? "0",
	);
	if (tagged > 0) return tagged;
	for (const [re, params] of DEFAULT_PARAMS) if (re.test(lower)) return params;
	return 0;
}

export function inferFamily(id: string): FamilyInfo {
	const lower = id.toLowerCase();
	const params = paramsOf(id);
	const family =
		[
			"qwen",
			"llama",
			"mistral",
			"gemma",
			"phi",
			"deepseek",
			"granite",
			"command-r",
			"nemotron",
		].find((f) => lower.includes(f)) ?? "unknown";
	const isCoder = /coder|code/.test(lower);
	const toolTuned =
		family === "qwen" || /tool|function|hermes|command-r/.test(lower);
	return { params, family, isCoder, toolTuned };
}

export interface Recommendation {
	id: string;
	params: number;
	ramGb: number;
	note: string;
	domains: WorkType[];
	installed: boolean;
	/** From the curated shortlist vs inferred from an installed model. */
	source: "catalog" | "installed";
}

/**
 * Recommend models for a domain + RAM, merging the curated shortlist with the
 * user's installed models. Curated picks that fit the domain+RAM come first
 * (bigger-within-fit ranked higher); installed-but-uncurated models that are
 * tool-capable are appended so nothing the user already has is hidden.
 */
export function recommendModels(
	domain: WorkType,
	ramGb: number,
	installed: string[] = [],
): Recommendation[] {
	const cap = maxParamsForRam(ramGb);
	const installedSet = new Set(installed);

	const fits = (e: CatalogEntry) => e.params <= cap && e.ramGb <= ramGb;
	const forDomain = (e: CatalogEntry) =>
		e.domains.includes(domain) || e.domains.includes("general");

	const curated = CATALOG.filter((e) => fits(e) && forDomain(e))
		.sort((a, b) => {
			// Domain-specific before general, then larger (better) within fit.
			const ad = a.domains.includes(domain) ? 0 : 1;
			const bd = b.domains.includes(domain) ? 0 : 1;
			return ad - bd || b.params - a.params;
		})
		.map<Recommendation>((e) => ({
			id: e.id,
			params: e.params,
			ramGb: e.ramGb,
			note: e.note,
			domains: e.domains,
			installed: installedSet.has(e.id),
			source: "catalog",
		}));

	// Installed models not already covered — inferred, so the tail is visible.
	const curatedIds = new Set(curated.map((r) => r.id));
	const inferred = installed
		.filter((id) => !curatedIds.has(id) && !id.includes("embed"))
		.map<Recommendation>((id) => {
			const f = inferFamily(id);
			const domains: WorkType[] = f.isCoder ? ["code", "review"] : ["general"];
			return {
				id,
				params: f.params,
				ramGb: Math.max(2, Math.round(f.params * 0.7)),
				note: `${f.family}${f.isCoder ? " coder" : ""}${f.toolTuned ? ", tool-tuned" : ""} — installed`,
				domains,
				installed: true,
				source: "installed",
			};
		})
		.filter((r) => r.params === 0 || r.params <= cap);

	return [...curated, ...inferred];
}

/** The curated per-model profile overrides for an id, if any (case-insensitive). */
export function catalogOverrides(id: string): ProfileOverride | undefined {
	const lower = id.toLowerCase();
	return CATALOG.find((e) => e.id.toLowerCase() === lower)?.profileOverrides;
}
