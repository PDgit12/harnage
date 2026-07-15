import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessPlan } from "../src/builder";
import { HARNESS_EVAL, HARNESS_TRACE } from "../src/builder/assemble/harness-templates";

// eval.ts is pure (no Bun-only imports), so we write it to a temp file and
// import it to exercise the real graders — doubling as an escaping check.
const dir = mkdtempSync(join(tmpdir(), "eval-"));
const file = join(dir, "eval.ts");
writeFileSync(file, HARNESS_EVAL);
type EvalResult = { name: string; pass: boolean; detail?: string };
const mod = (await import(file)) as {
	runDeterministicEvals: (
		goal: string,
		answer: string,
		messages: Array<Record<string, unknown>>,
		toolCount: number,
	) => EvalResult[];
	parseJudgeScore: (raw: string) => EvalResult | null;
	judgeRequest: (goal: string, answer: string) => Array<Record<string, unknown>>;
};

describe("generated eval graders", () => {
	it("passes a clean tool-using run", () => {
		const r = mod.runDeterministicEvals(
			"read foo.ts",
			"The file exports a helper.",
			[{ role: "tool", content: "Observation from file_read: ..." }],
			2,
		);
		const map = Object.fromEntries(r.map((e) => [e.name, e.pass]));
		expect(map.non_empty_answer).toBe(true);
		expect(map.completed_without_stop).toBe(true);
		expect(map.prose_answer).toBe(true);
		expect(map.used_tool_when_available).toBe(true);
	});

	it("flags a stopped run and no tool use", () => {
		const r = mod.runDeterministicEvals("do x", "Stopped: too many failures", [], 2);
		const map = Object.fromEntries(r.map((e) => [e.name, e.pass]));
		expect(map.completed_without_stop).toBe(false);
		expect(map.used_tool_when_available).toBe(false);
	});

	it("flags a raw JSON blob as non-prose", () => {
		const r = mod.runDeterministicEvals("x", '{"text":"hi"}', [], 0);
		expect(r.find((e) => e.name === "prose_answer")?.pass).toBe(false);
	});

	it("parses a judge score and rejects unscorable text", () => {
		expect(mod.parseJudgeScore("SCORE: 4 — solid")?.pass).toBe(true);
		expect(mod.parseJudgeScore("SCORE: 2 — weak")?.pass).toBe(false);
		expect(mod.parseJudgeScore("no number")).toBeNull();
	});

	it("builds a two-message judge request", () => {
		const req = mod.judgeRequest("goal", "answer");
		expect(req.map((m) => m.role)).toEqual(["system", "user"]);
	});
});

describe("HARNESS_TRACE template", () => {
	const code = HARNESS_TRACE({ name: "testagent" } as HarnessPlan);
	it("reads the plan's audit trail and exports printTrace", () => {
		expect(code).toContain('".testagent", "audit.jsonl"');
		expect(code).toContain("export function printTrace");
	});
	it("aggregates runs, latency, tool calls, and eval pass rate", () => {
		expect(code).toContain('e.kind === "run_start"');
		expect(code).toContain('e.kind === "tool_call"');
		expect(code).toContain('e.kind === "eval"');
		expect(code).toContain("Eval pass");
	});
	it("splits audit lines on an escaped newline, not a real linebreak", () => {
		expect(code).toContain('.split("\\n")');
		expect(code).not.toContain('.split("\n")');
	});
});
