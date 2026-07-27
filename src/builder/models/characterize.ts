/**
 * CHARACTERIZE — measure what the chosen model can actually do, BEFORE the
 * harness is generated for it.
 *
 * Until now the scaffold was inferred from a parameter count: "<=3.5B means
 * pipeline + constrained JSON, >=13B means free loop + native tool-calling".
 * That is a guess dressed as a rule, and it has been wrong in a way that cost
 * real accuracy — a measured A/B on qwen2.5:3b scored constrained-json 14/20
 * against native 7/20, i.e. the native channel the size-tier would happily hand
 * a slightly larger model is HALF as good on a model that is explicitly
 * tool-tuned. Nothing about the parameter count predicts that.
 *
 * So: run a handful of one-turn probes against the real endpoint, and derive
 * the profile from what came back. Every probe answers one question that
 * changes a scaffold decision, and each is cheap — a few hundred tokens.
 *
 * Fail-safe by construction. An unreachable or slow model yields an empty
 * override and the caller keeps its size-tier default, so characterization can
 * never make a build worse than not running it.
 */
import type { Provider } from "../../services/api/client";
import { completeText } from "../../services/api/complete";
import type { ProfileOverride } from "./catalog";

export interface Characterization {
	/** Emitted parseable JSON matching a requested shape. */
	json: boolean;
	/** Produced a well-formed native tool_call when tools were offered. */
	nativeTools: boolean;
	/** Used an exact path it was given rather than inventing one. */
	pathFidelity: boolean;
	/** Kept to a single action instead of narrating a plan. */
	acts: boolean;
	/** Median probe latency, ms — feeds the tool-budget decision. */
	medianMs: number;
	/** Probes that actually returned; 0 means the model was unreachable. */
	completed: number;
	/** The derived scaffold. Empty when nothing could be measured. */
	override: ProfileOverride;
}

interface Probe {
	id: keyof Omit<Characterization, "medianMs" | "completed" | "override">;
	prompt: string;
	/** True when the reply demonstrates the capability. */
	pass: (raw: string) => boolean;
}

const PROBES: Probe[] = [
	{
		id: "json",
		prompt:
			'Reply with ONLY this JSON object and nothing else: {"action":"tool","tool":"file_read","args":{"path":"a.ts"}}',
		pass: (raw) => {
			const m = raw.match(/\{[\s\S]*\}/);
			if (!m) return false;
			try {
				const o = JSON.parse(m[0]) as Record<string, unknown>;
				return o.action === "tool" && o.tool === "file_read";
			} catch {
				return false;
			}
		},
	},
	{
		id: "pathFidelity",
		prompt:
			"The working directory contains exactly these files: notes/todo.md, src/util/format.ts, readme.md\n" +
			"Which file holds the formatName function? Reply with ONLY the path, copied exactly from that list.",
		// The failure this catches is real and common: the model answers
		// "src/format.ts" or "./util/format.ts" — a path that does not exist.
		pass: (raw) => {
			const a = raw.trim().replace(/^['"`]|['"`]$/g, "");
			return (
				a.includes("src/util/format.ts") && !/\.\/src|^src\/format/.test(a)
			);
		},
	},
	{
		id: "acts",
		prompt:
			'You must create a file. Reply with ONLY this JSON and nothing else — no explanation, no shell command: {"action":"tool","tool":"file_write","args":{"path":"hello.txt","content":"HELLO"}}',
		// A model that answers with `echo "HELLO" > hello.txt` or a paragraph of
		// instructions fails here — and will fail every write task in the harness.
		pass: (raw) => {
			if (
				/echo\s|terminal|command line|you (can|should|need to) run/i.test(raw)
			)
				return false;
			const m = raw.match(/\{[\s\S]*\}/);
			if (!m) return false;
			try {
				const o = JSON.parse(m[0]) as { tool?: string };
				return o.tool === "file_write";
			} catch {
				return false;
			}
		},
	},
];

/** One probe, with its own timeout so a stalled model can't hang a build. */
async function runProbe(
	provider: Provider,
	probe: Probe,
	timeoutMs: number,
): Promise<{ ok: boolean; ms: number } | null> {
	const started = performance.now();
	try {
		const result = await Promise.race([
			completeText(provider, [{ role: "user", content: probe.prompt }]),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("probe timeout")), timeoutMs),
			),
		]);
		return { ok: probe.pass(result.text), ms: performance.now() - started };
	} catch {
		return null;
	}
}

/**
 * Probe the model and derive its scaffold. `base` is the size-tier guess; the
 * returned override is what MEASUREMENT says to change about it.
 */
export async function characterizeModel(
	provider: Provider,
	opts?: { timeoutMs?: number },
): Promise<Characterization> {
	const timeoutMs = opts?.timeoutMs ?? 45_000;
	const results = await Promise.all(
		PROBES.map((p) => runProbe(provider, p, timeoutMs).then((r) => ({ p, r }))),
	);

	const flags: Record<string, boolean> = {};
	const latencies: number[] = [];
	let completed = 0;
	for (const { p, r } of results) {
		if (!r) continue;
		completed++;
		flags[p.id] = r.ok;
		latencies.push(r.ms);
	}

	latencies.sort((a, b) => a - b);
	const medianMs = latencies.length
		? Math.round(latencies[Math.floor(latencies.length / 2)])
		: 0;

	const characterization: Characterization = {
		json: flags.json ?? false,
		// Not probed separately yet: offering tool defs needs the generated tool
		// schemas, which do not exist this early. Reported as false rather than
		// guessed, so nothing downstream treats it as evidence.
		nativeTools: false,
		pathFidelity: flags.pathFidelity ?? false,
		acts: flags.acts ?? false,
		medianMs,
		completed,
		override: {},
	};

	// Nothing measured — the model was unreachable or every probe timed out.
	// Return an empty override so the size-tier default stands untouched.
	if (completed === 0) return characterization;

	const override: ProfileOverride = {};

	// A model that cannot hold a JSON shape for one turn cannot drive the
	// constrained-json dispatch reliably; give it the tightest scaffold there is.
	if (!characterization.json) {
		override.loop = "pipeline";
		override.temperature = 0;
		override.maxTools = 3;
	}

	// Invents paths → keep the tool surface small so the goal-relevant tools are
	// the ones it sees, and drop the temperature so it stops improvising.
	if (!characterization.pathFidelity) {
		override.maxTools = Math.min(override.maxTools ?? 4, 4);
		override.temperature = 0;
	}

	// Describes instead of acting → the narration backstop earns its cost here.
	if (!characterization.acts) {
		override.nudge = true;
		override.loop = "pipeline";
	}

	// Slow endpoint: fewer tools means shorter prompts and fewer turns, which is
	// the only lever the harness has over wall-clock time.
	if (medianMs > 12_000) {
		override.maxTools = Math.min(override.maxTools ?? 4, 4);
	}

	characterization.override = override;
	return characterization;
}

/** One-line summary for build progress output. */
export function describeCharacterization(c: Characterization): string {
	if (c.completed === 0)
		return "model unreachable — keeping the size-tier default";
	const marks = [
		`json ${c.json ? "ok" : "weak"}`,
		`paths ${c.pathFidelity ? "ok" : "weak"}`,
		`acts ${c.acts ? "ok" : "weak"}`,
		`~${Math.round(c.medianMs / 100) / 10}s/turn`,
	].join(" · ");
	const tuned = Object.keys(c.override).length;
	return `${marks}${tuned ? ` → ${tuned} scaffold override(s)` : " → no change needed"}`;
}
