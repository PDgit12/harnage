/**
 * ACCEPTANCE stage — the domain battery a harness is tested against before it is
 * handed over.
 *
 * The model the harness will RUN on is chosen before the build (recommendModels
 * → plan.defaultLocalModel), so by the time we get here we can actually execute
 * the finished harness against its own domain and report whether it works. What
 * was missing was the tasks: the generated src/eval.ts only holds generic
 * per-run rules (non-empty answer, used-a-tool), which say nothing about whether
 * an n8n harness can produce a workflow.
 *
 * THE BUILD BRAIN NEVER WRITES CODE HERE. It emits tasks as data — a goal, some
 * fixture files, and a typed expectation — which harnage evaluates itself. A
 * model-authored grader is a grader nobody reviewed: it can be silently vacuous
 * (passing on an empty answer) or silently wrong, and it would execute on the
 * user's machine. A closed DSL gives up a little expressiveness and buys back
 * every one of those properties.
 */
import { z } from "zod";
import type { Provider } from "../../services/api/client";
import type { HarnessPlan } from "../index";
import { completeJSON } from "./client";

export const ExpectationSchema = z.object({
	type: z.enum(["contains", "not_contains", "file_exists", "file_contains"]),
	/** Substring to look for. Required for everything except file_exists. */
	value: z.string().optional(),
	/** Fixture-relative path. Required for the file_* types. */
	path: z.string().optional(),
});

export const AcceptanceTaskSchema = z.object({
	id: z.string().min(1).max(60),
	goal: z.string().min(10).max(400),
	fixture: z
		.array(
			z.object({
				path: z.string().min(1).max(120),
				content: z.string().max(4000),
			}),
		)
		.max(6)
		.optional(),
	expect: ExpectationSchema,
	rubric: z.string().max(400).optional(),
});

export type Expectation = z.infer<typeof ExpectationSchema>;
export type AcceptanceTask = z.infer<typeof AcceptanceTaskSchema>;

const AcceptancePlanSchema = z.object({
	tasks: z.array(AcceptanceTaskSchema).min(1).max(10),
});

/** A path is usable only if it stays inside the fixture dir. Mirrors the same
 *  guard the repair loop applies to patch paths. */
export function isSafeFixturePath(p: string): boolean {
	if (!p || p.startsWith("/") || p.includes("..")) return false;
	// Windows-style absolute / drive-letter paths and NUL bytes.
	return !/^[a-zA-Z]:/.test(p) && !p.includes("\0");
}

/**
 * Reject tasks that cannot actually discriminate. Learned the hard way: the
 * eval battery's own --dry-run found 4 hand-written checks that passed on an
 * EMPTY answer, i.e. graded nothing. A model writing them is far more likely to
 * produce that, so every task is screened before it can score a harness.
 */
export function taskProblem(task: AcceptanceTask): string | null {
	const { expect: e } = task;

	if (e.type === "file_exists" || e.type === "file_contains") {
		if (!e.path) return "file expectation without a path";
		if (!isSafeFixturePath(e.path)) return `unsafe path: ${e.path}`;
	}
	if (e.type !== "file_exists") {
		if (!e.value?.trim()) return `${e.type} expectation without a value`;
		// A 1-2 char substring matches by accident in any prose answer.
		if (e.value.trim().length < 3)
			return `expectation value too short: "${e.value}"`;
	}
	// not_contains alone is satisfied by saying nothing at all.
	if (e.type === "not_contains" && !task.rubric) {
		return "not_contains needs a rubric — an empty answer would pass it";
	}
	for (const f of task.fixture ?? []) {
		if (!isSafeFixturePath(f.path)) return `unsafe fixture path: ${f.path}`;
	}
	return null;
}

/** Grade one answer. `fixtureDir` is where the harness ran, so file
 *  expectations see what it actually wrote. */
export function grade(
	task: AcceptanceTask,
	answer: string,
	readFile: (relPath: string) => string | null,
): boolean {
	const e = task.expect;
	switch (e.type) {
		case "contains":
			return answer.toLowerCase().includes((e.value ?? "").toLowerCase());
		case "not_contains":
			// Substance required: an empty answer must not pass by omission.
			return (
				answer.trim().length > 15 &&
				!answer.toLowerCase().includes((e.value ?? "").toLowerCase())
			);
		case "file_exists":
			return readFile(e.path ?? "") !== null;
		case "file_contains": {
			const body = readFile(e.path ?? "");
			return (
				body !== null &&
				body.toLowerCase().includes((e.value ?? "").toLowerCase())
			);
		}
	}
}

const EXAMPLE = `{
  "tasks": [
    { "id": "workflow:generate", "goal": "Generate a workflow JSON for a daily Slack digest and save it to wf.json",
      "expect": { "type": "file_contains", "path": "wf.json", "value": "nodes" } },
    { "id": "workflow:read", "goal": "Read existing.json and tell me how many nodes the workflow has",
      "fixture": [{ "path": "existing.json", "content": "{\\"name\\":\\"demo\\",\\"nodes\\":[{\\"id\\":1},{\\"id\\":2}]}" }],
      "expect": { "type": "contains", "value": "2" } },
    { "id": "workflow:absent", "goal": "Read missing-workflow.json and summarize it",
      "expect": { "type": "not_contains", "value": "nodes" },
      "rubric": "PASS if the answer says the file does not exist. FAIL if it invents workflow contents." }
  ]
}`;

/**
 * Ask the build brain for a domain battery for THIS harness. Best-effort by
 * design: a failure here must never cost the user their build — they just don't
 * get a score.
 */
export async function runGenerateAcceptance(
	provider: Provider,
	plan: HarnessPlan,
	purpose: string,
): Promise<AcceptanceTask[]> {
	const bespoke = [
		...(plan.customCommands ?? []).map((c) => `/${c.name}: ${c.description}`),
		...plan.tools.map((t) => `tool ${t}`),
	]
		.slice(0, 12)
		.join("\n");

	const prompt = `Write an acceptance battery for an AI agent harness, to check it actually works before shipping.

Harness: ${plan.name} — ${plan.description}
Purpose: ${purpose}
Capabilities:
${bespoke}

Write 6 tasks that a WORKING harness passes and a broken one fails. Rules:
- Each task is a concrete goal the agent is given, in this harness's real domain.
- The agent runs in an empty temp directory. If a task needs input files, declare them in "fixture" — do not assume anything else exists.
- "expect" is how the task is graded, one of:
  - {"type":"contains","value":"<substring the answer must contain>"}
  - {"type":"not_contains","value":"<substring that means it hallucinated>"} — MUST also set "rubric"
  - {"type":"file_exists","path":"<file the agent must create>"}
  - {"type":"file_contains","path":"<file>","value":"<substring it must contain>"}
- Expectation values must be at least 3 characters and must be things a CORRECT answer really contains — a fact, a number, a filename. Never grade on filler words.
- Cover a mix: at least 2 that make the agent WRITE a file, at least 1 where the requested thing does not exist and the agent must say so.
- ids look like "area:short-name".

Example output:
${EXAMPLE}

Respond with ONLY JSON in that shape.`;

	const { tasks } = await completeJSON(provider, prompt, AcceptancePlanSchema);

	// Screen every task; keep the good ones rather than discarding the battery
	// over one bad entry (same allSettled spirit as runGenerate).
	const kept: AcceptanceTask[] = [];
	const seen = new Set<string>();
	for (const t of tasks) {
		const problem = taskProblem(t);
		if (problem) {
			console.warn(`Acceptance task "${t.id}" rejected — ${problem}`);
			continue;
		}
		if (seen.has(t.id)) continue;
		seen.add(t.id);
		kept.push(t);
	}
	return kept;
}
