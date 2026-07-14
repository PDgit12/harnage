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
	},
	{
		id: "qwen2.5-coder:7b",
		params: 7,
		ramGb: 5,
		domains: ["code", "review"],
		note: "Best code reasoning that fits 8GB",
		license: "Apache-2.0",
	},
	{
		id: "qwen3:8b",
		params: 8,
		ramGb: 6,
		domains: ["general", "code", "data", "docs", "review"],
		note: "Best all-round local agent — native tool-calling",
		license: "Apache-2.0",
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

export interface FamilyInfo {
	params: number;
	family: string;
	isCoder: boolean;
	toolTuned: boolean;
}

/** Layer 2: infer capability signals from a model id we don't have curated. */
export function inferFamily(id: string): FamilyInfo {
	const lower = id.toLowerCase();
	const params = Number.parseFloat(lower.match(/(\d+(?:\.\d+)?)b/)?.[1] ?? "0");
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
