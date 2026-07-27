import { describe, expect, it } from "vitest";
import {
	optimizationCandidates,
	renderAcceptanceMd,
} from "../src/builder/acceptance-run";
import {
	ENGINE_TEMPLATE,
	HARNESS_PERMISSIONS,
} from "../src/builder/assemble/harness-templates";
import type { HarnessPlan } from "../src/builder/index";
import {
	type AcceptanceTask,
	grade,
	isSafeFixturePath,
	taskProblem,
} from "../src/builder/llm/acceptance";
import {
	BASELINE_TOOLS,
	classifyDomain,
	domainToolPriority,
} from "../src/builder/models/catalog";
import { parseIntent } from "../src/builder/spec";

// ── Tool scoping: capability is universal, PRIORITY is what specialises ──────
// An earlier attempt withheld tools per domain. That looked like specialisation
// but was guesswork: "n8n automation" classifies as `general`, so dropping bash
// and web_fetch left it unable to reach an HTTP endpoint at all. Every harness
// now ships the full kit; the domain decides what the model is SHOWN first,
// which is what actually matters when a small model can only see a few tools.
describe("every harness ships the full tool kit", () => {
	const prompts = [
		"a CLI agent that reviews pull requests and flags risky changes",
		"a personal note-taking agent that stores notes and retrieves them later",
		"an n8n automation builder that connects to my n8n instance and imports workflows",
		"a documentation question-answering agent that searches markdown docs",
	];

	it("gives every domain the same baseline capability", () => {
		for (const p of prompts) {
			const tools = parseIntent(p).tools;
			for (const t of BASELINE_TOOLS) {
				expect(tools, `"${p.slice(0, 30)}" is missing ${t}`).toContain(t);
			}
		}
	});

	it("still lets keyword triggers ADD tools on top", () => {
		const research = parseIntent(
			"a GTM research agent that looks up companies and writes a brief",
		).tools;
		expect(research).toContain("web_search");
		expect(research.length).toBeGreaterThan(BASELINE_TOOLS.length);
	});
});

describe("domain decides tool PRIORITY, not availability", () => {
	it("ranks the tool each domain actually reaches for first", () => {
		// A code agent leans on the shell; a docs agent on search.
		expect(domainToolPriority("code").slice(0, 2)).toEqual([
			"file_read",
			"bash",
		]);
		expect(domainToolPriority("docs").slice(0, 2)).toEqual([
			"file_read",
			"grep",
		]);
		expect(domainToolPriority("general").slice(0, 3)).toContain("web_fetch");
	});

	it("every priority list is a permutation, never a filter", () => {
		for (const d of ["code", "review", "data", "docs", "general"] as const) {
			const p = domainToolPriority(d);
			expect(new Set(p).size).toBe(p.length); // no duplicates
			expect(p.length).toBeGreaterThanOrEqual(6);
		}
	});

	it("bakes the domain ranking into the generated engine", () => {
		const docs = ENGINE_TEMPLATE({
			name: "d",
			description: "answers questions from markdown documentation",
			systemPrompt: "",
			tools: ["file_read"],
		} as unknown as HarnessPlan);
		// NB: classifyDomain checks `review` BEFORE `code`, so a description
		// mentioning review/refactor is a review harness, not a code one.
		const code = ENGINE_TEMPLATE({
			name: "c",
			description: "compiles a typescript program and runs its test function",
			systemPrompt: "",
			tools: ["file_read"],
		} as unknown as HarnessPlan);

		expect(
			classifyDomain("answers questions from markdown documentation"),
		).toBe("docs");
		const pick = (src: string) =>
			JSON.parse(
				(src.match(/const DOMAIN_TOOL_PRIORITY: string\[\] = (\[.*?\]);/) ??
					[])[1] ?? "[]",
			) as string[];
		expect(pick(docs)[1]).toBe("grep");
		expect(pick(code)[1]).toBe("bash");
	});
});

// ── Acceptance DSL ──────────────────────────────────────────────────────────
const task = (over: Partial<AcceptanceTask>): AcceptanceTask =>
	({
		id: "t:1",
		goal: "do the thing in the domain",
		expect: { type: "contains", value: "hello" },
		...over,
	}) as AcceptanceTask;

describe("acceptance task screening", () => {
	it("accepts a well-formed task", () => {
		expect(taskProblem(task({}))).toBeNull();
		expect(
			taskProblem(
				task({ expect: { type: "file_exists", path: "out/wf.json" } }),
			),
		).toBeNull();
	});

	it("rejects expectations that grade nothing", () => {
		// Too short — matches by accident in any prose.
		expect(
			taskProblem(task({ expect: { type: "contains", value: "ok" } })),
		).toMatch(/too short/);
		expect(
			taskProblem(task({ expect: { type: "contains", value: "  " } })),
		).toMatch(/without a value/);
		// not_contains with no rubric is satisfied by saying nothing.
		expect(
			taskProblem(task({ expect: { type: "not_contains", value: "nodes" } })),
		).toMatch(/rubric/);
		expect(
			taskProblem(
				task({
					expect: { type: "not_contains", value: "nodes" },
					rubric: "PASS if it says the file is missing.",
				}),
			),
		).toBeNull();
	});

	it("rejects file expectations that escape the fixture dir", () => {
		expect(
			taskProblem(
				task({ expect: { type: "file_exists", path: "../../etc/passwd" } }),
			),
		).toMatch(/unsafe/);
		expect(
			taskProblem(
				task({ expect: { type: "file_exists", path: "/etc/passwd" } }),
			),
		).toMatch(/unsafe/);
		expect(
			taskProblem(
				task({
					fixture: [{ path: "../evil.ts", content: "x" }],
					expect: { type: "contains", value: "hello" },
				}),
			),
		).toMatch(/unsafe fixture/);
		expect(isSafeFixturePath("a/b/c.json")).toBe(true);
		expect(isSafeFixturePath("C:\\win")).toBe(false);
	});

	it("rejects a file expectation with no path", () => {
		expect(
			taskProblem(task({ expect: { type: "file_contains", value: "nodes" } })),
		).toMatch(/without a path/);
	});
});

// A rate limit is not a verdict. Scoring one as a task failure blames the
// harness for an exhausted quota and sends the user chasing a bigger model —
// observed for real: two tasks "failed" on a Groq 429 during a live build.
describe("acceptance report excludes provider errors from the score", () => {
	it("renders errored tasks as SKIP and notes the exclusion", () => {
		const md = renderAcceptanceMd("n8n-builder", {
			model: "llama-3.3-70b",
			tier: "strong",
			loop: "free",
			passed: 3,
			total: 3,
			bar: 3,
			met: true,
			errored: 2,
			tasks: [
				{ id: "wf:generate", pass: true, ms: 1200, detail: "ok" },
				{ id: "wf:read", pass: true, ms: 900, detail: "ok" },
				{ id: "wf:absent", pass: true, ms: 800, detail: "ok" },
				{
					id: "wf:export",
					pass: false,
					ms: 300,
					errored: true,
					detail: "openai 429: Rate limit reached",
				},
				{
					id: "wf:connect",
					pass: false,
					ms: 300,
					errored: true,
					detail: "openai 429: Rate limit reached",
				},
			],
		});
		expect(md).toContain("SKIP");
		expect(md).toContain("3/3");
		expect(md).toContain("MET");
		expect(md).toMatch(/2 task\(s\) hit a provider error/);
		// The errored tasks must not read as harness failures.
		expect(md).not.toMatch(/\| FAIL \| `wf:export`/);
	});

	it("reports nothing-measured rather than a pass when everything errored", () => {
		const md = renderAcceptanceMd("x", {
			model: "m",
			tier: "small",
			loop: "pipeline",
			passed: 0,
			total: 0,
			bar: 0,
			met: false,
			errored: 2,
			tasks: [],
			skipped:
				"every task hit a provider error (rate limit or connectivity) — nothing was measured",
		});
		expect(md).toMatch(/nothing was measured/);
		expect(md).not.toContain("MET");
	});
});

describe("acceptance grading", () => {
	const noFiles = () => null;

	it("grades contains case-insensitively", () => {
		expect(grade(task({}), "Well, HELLO there", noFiles)).toBe(true);
		expect(grade(task({}), "nothing here", noFiles)).toBe(false);
	});

	it("never passes not_contains on an empty or trivial answer", () => {
		const t = task({
			expect: { type: "not_contains", value: "nodes" },
			rubric: "r",
		});
		expect(grade(t, "", noFiles)).toBe(false);
		expect(grade(t, "  ", noFiles)).toBe(false);
		expect(grade(t, "That workflow file does not exist here.", noFiles)).toBe(
			true,
		);
		expect(grade(t, "It has 3 nodes configured for you", noFiles)).toBe(false);
	});

	it("reads the fixture dir for file expectations", () => {
		const files: Record<string, string> = { "wf.json": '{"nodes":[]}' };
		const read = (p: string) => files[p] ?? null;
		expect(
			grade(
				task({ expect: { type: "file_exists", path: "wf.json" } }),
				"",
				read,
			),
		).toBe(true);
		expect(
			grade(
				task({ expect: { type: "file_exists", path: "nope.json" } }),
				"",
				read,
			),
		).toBe(false);
		expect(
			grade(
				task({
					expect: { type: "file_contains", path: "wf.json", value: "nodes" },
				}),
				"",
				read,
			),
		).toBe(true);
		expect(
			grade(
				task({
					expect: { type: "file_contains", path: "wf.json", value: "cron" },
				}),
				"",
				read,
			),
		).toBe(false);
	});
});

// ── Small-model act enforcement ─────────────────────────────────────────────
// Both of these target the SAME observed failure: given "create hello.txt
// containing HELLO", qwen2.5:3b called glob and file_read (so the existing
// toolsUsed===0 act-nudge never fired) and then finalized with "to create a
// file you need to run a command…". Prose is not an artifact.
describe("generated engine enforces outcomes and constrains tool names", () => {
	const engine = ENGINE_TEMPLATE({
		name: "e",
		description: "an agent",
		systemPrompt: "",
		tools: ["file_read"],
	} as unknown as HarnessPlan);

	const pick = (src: string) => {
		const m = src.match(
			/function requestedArtifact\(goal: string\): string \| null \{([\s\S]*?)\n\}/,
		);
		return new Function("goal", (m as RegExpMatchArray)[1]) as (
			g: string,
		) => string | null;
	};

	it("extracts the artifact a creation goal names", () => {
		const f = pick(engine);
		expect(f("Create a file named hello.txt containing exactly HELLO")).toBe(
			"hello.txt",
		);
		expect(f("Write the workflow to wf.json")).toBe("wf.json");
		expect(f('Generate a report and save it as "out/report.md"')).toBe(
			"out/report.md",
		);
	});

	it("stays silent when the goal names no artifact to produce", () => {
		const f = pick(engine);
		// Read-only goals must not be forced to write anything.
		expect(f("What does a.ts export?")).toBeNull();
		expect(f("Count the rows in data.csv")).toBeNull();
		// Creation verb but no filename — nothing to check.
		expect(f("Create a summary of the findings")).toBeNull();
	});

	it("refuses a path that escapes the working directory", () => {
		const f = pick(engine);
		expect(f("Write the output to ../../etc/passwd")).toBeNull();
		expect(f("Save it as /etc/hosts")).toBeNull();
	});

	it("constrains the tool name to an enum, and can remove the final branch", () => {
		const m = engine.match(
			/function decisionSchema\(toolNames: string\[\], forceTool = false\): Record<string, unknown> \{([\s\S]*?)\n\}/,
		);
		const decisionSchema = new Function(
			"toolNames",
			"forceTool",
			(m as RegExpMatchArray)[1],
		) as (t: string[], f?: boolean) => Record<string, unknown>;

		const normal = decisionSchema(["file_read", "file_write"]) as {
			properties: Record<string, { enum?: string[] }>;
			required: string[];
		};
		// An invented name like "GrepTool" is now impossible to emit.
		expect(normal.properties.tool.enum).toEqual(["file_read", "file_write"]);
		expect(normal.properties.action.enum).toEqual(["tool", "final"]);

		const forced = decisionSchema(["file_write"], true) as {
			properties: Record<string, { enum?: string[] }>;
			required: string[];
		};
		// Forced turn: the model cannot stop, only act.
		expect(forced.properties.action.enum).toEqual(["tool"]);
		expect(forced.required).toContain("tool");
	});
});

// Typed args: decisionSchema constrains WHICH tool may be named; it cannot stop
// the model inventing argument keys ({tool:"file_write", args:{filename:"x"}}
// satisfies args:{type:"object"} and then fails at call time). The oneOf pushes
// that into the grammar itself.
describe("typed per-tool argument grammar", () => {
	const engine = ENGINE_TEMPLATE({
		name: "e",
		description: "an agent",
		systemPrompt: "",
		tools: ["file_read"],
	} as unknown as HarnessPlan);

	it("emits a discriminated union keyed on the tool name", () => {
		expect(engine).toContain("typedDecisionSchema");
		expect(engine).toContain("oneOf");
		// additionalProperties:false is what makes a wrong arg key impossible.
		expect(engine).toContain("additionalProperties: false");
	});

	it("falls back to the flat schema when a provider rejects the union", () => {
		// A host that can't compile a oneOf grammar must degrade, not kill the run.
		expect(engine).toMatch(/format\|schema\|grammar\|oneOf/);
		expect(engine).toContain("useTypedArgs = false");
	});
});

// The single highest-value bug found today, and the one most likely to recur:
// a permissions matcher that refused honest work while stopping nothing. Under
// an explicit `bash(*)` grant, "echo HELLO > f.txt" was denied with the message
// "needs an allow rule ... bash(*)" — add the rule you already have. It made a
// harness bug look like a small model refusing to act, and cost most of a day.
describe("bash permission matcher", () => {
	const perms = HARNESS_PERMISSIONS({
		name: "e",
		description: "an agent",
		systemPrompt: "",
		tools: ["bash"],
	} as unknown as HarnessPlan);

	const ruleMatches = (() => {
		const m = perms.match(
			/function ruleMatches\(rule: PermissionRule, toolName: string, target: string\): boolean \{([\s\S]*?)\n\}/,
		);
		return new Function(
			"rule",
			"toolName",
			"target",
			(m as RegExpMatchArray)[1],
		) as (
			r: { pattern: string; allow: boolean },
			t: string,
			g: string,
		) => boolean;
	})();

	const wildcard = { pattern: "bash(*)", allow: true };
	const scoped = { pattern: "bash(git *)", allow: true };

	it("honours an explicit allow-everything grant, redirects included", () => {
		expect(ruleMatches(wildcard, "bash", "echo 'HELLO' > hello.txt")).toBe(
			true,
		);
		expect(ruleMatches(wildcard, "bash", "cat a.txt | wc -l")).toBe(true);
		expect(ruleMatches(wildcard, "bash", "touch t.txt")).toBe(true);
	});

	it("still blocks chaining out of a SCOPED grant", () => {
		// This is what the guard exists for and must keep doing.
		expect(ruleMatches(scoped, "bash", "git status; rm -rf /")).toBe(false);
		expect(ruleMatches(scoped, "bash", "git log > /etc/passwd")).toBe(false);
		expect(ruleMatches(scoped, "bash", "git $(whoami)")).toBe(false);
		// A plain in-scope command still matches.
		expect(ruleMatches(scoped, "bash", "git status")).toBe(true);
		// Out of scope stays out of scope.
		expect(ruleMatches(scoped, "bash", "npm publish")).toBe(false);
	});

	it("does not apply the bash guard to other tools", () => {
		expect(
			ruleMatches(
				{ pattern: "file_write(*)", allow: true },
				"file_write",
				"a>b.txt",
			),
		).toBe(true);
	});
});

// The optimize loop is what makes a delivered harness TUNED rather than merely
// tested. Its candidates must come from HOW it failed — a blind sweep costs
// several minutes of battery per variant for combinations unrelated to the
// observed failure.
describe("acceptance optimize loop", () => {
	const report = (
		tasks: Array<{ pass: boolean; detail: string; errored?: boolean }>,
	) =>
		({
			model: "m",
			tier: "small",
			loop: "pipeline",
			passed: tasks.filter((t) => t.pass).length,
			total: tasks.length,
			bar: tasks.length,
			met: false,
			tasks: tasks.map((t, i) => ({ id: `t${i}`, ms: 1, ...t })),
		}) as Parameters<typeof optimizationCandidates>[0];

	it("prescribes act-forcing when the model described the work", () => {
		const c = optimizationCandidates(
			report([
				{ pass: false, detail: 'you need to run `echo "HELLO" > hello.txt`' },
			]),
		);
		expect(c[0].override.nudge).toBe(true);
		expect(c[0].override.loop).toBe("pipeline");
	});

	it("prescribes tighter grounding when it reached for absent things", () => {
		const c = optimizationCandidates(
			report([
				{ pass: false, detail: "the file src/util/x.ts does not exist" },
			]),
		);
		expect(c[0].override.maxTools).toBe(3);
		expect(c[0].override.temperature).toBe(0);
	});

	it("falls back to the tightest scaffold when failures are not diagnostic", () => {
		const c = optimizationCandidates(
			report([{ pass: false, detail: "wrong" }]),
		);
		expect(c).toHaveLength(1);
		expect(c[0].override.loop).toBe("pipeline");
	});

	it("ignores infra-errored tasks when choosing a candidate", () => {
		// A rate limit says nothing about the scaffold; tuning on it would be
		// chasing noise.
		const c = optimizationCandidates(
			report([
				{ pass: false, detail: "openai 429 rate limit", errored: true },
				{ pass: false, detail: "you should run this in your terminal" },
			]),
		);
		expect(c[0].override.nudge).toBe(true);
	});

	it("never proposes more than two retries", () => {
		const c = optimizationCandidates(
			report([
				{ pass: false, detail: "you need to run echo foo" },
				{ pass: false, detail: "does not exist" },
				{ pass: false, detail: "unknown tool" },
			]),
		);
		expect(c.length).toBeLessThanOrEqual(2);
	});
});
