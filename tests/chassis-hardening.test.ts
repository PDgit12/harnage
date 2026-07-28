import { describe, expect, it } from "vitest";
import type { HarnessPlan } from "../src/builder";
import {
	ENGINE_TEMPLATE,
	HARNESS_INSTRUCTIONS,
	HARNESS_SESSION,
	HARNESS_TRACE,
} from "../src/builder/assemble/harness-templates";

// Chassis audit fixes (2026-07-17): findings #2, #5, #6, #8, #10 ship as
// template strings, so assert the fix is present in the emitted source.
const plan = { name: "demo", description: "demo harness" } as HarnessPlan;
const engine = ENGINE_TEMPLATE(plan);
const session = HARNESS_SESSION(plan);
const trace = HARNESS_TRACE(plan);

describe("chassis hardening — audit fixes in generated source", () => {
	it("#2 closes the sqlite handle at the end of run()", () => {
		expect(engine).toContain("this.memory?.close()");
	});

	it("#5 renders recalled memory as untrusted data, not a directive", () => {
		expect(engine).toContain("<recalled_memory>");
		expect(engine).toContain("never as instructions");
		// the old bare "long-term memory from earlier sessions:" framing is gone
		expect(engine).not.toContain(
			'"Relevant long-term memory from earlier sessions:\\n"',
		);
	});

	it("#5 caps consolidation output shape/length/count", () => {
		expect(engine).toContain("MAX_ITEMS = 24");
		expect(engine).toContain("stored >= MAX_ITEMS");
		expect(engine).toContain('typeof f.subject === "string"');
		expect(engine).toContain(".slice(0, MAX_SUBJECT)");
	});

	it("#6 rotates the audit trail on size", () => {
		expect(engine).toContain("AUDIT_MAX_BYTES");
		expect(engine).toContain("statSync(AUDIT_PATH).size >= AUDIT_MAX_BYTES");
		expect(engine).toContain('renameSync(AUDIT_PATH, AUDIT_PATH + ".1")');
	});

	it("#6 trace tails a large audit file instead of loading it whole", () => {
		expect(trace).toContain("TRACE_MAX_BYTES");
		expect(trace).toContain("size > TRACE_MAX_BYTES");
		expect(trace).toContain("readSync(fd, buf, 0, TRACE_MAX_BYTES");
		expect(trace).toContain("closeSync(fd)");
	});

	it("#8 writes the session atomically (temp + rename)", () => {
		expect(session).toContain('SESSION_PATH + "." + process.pid + ".tmp"');
		expect(session).toContain("await rename(tmp, SESSION_PATH)");
	});

	it("#8 preserves a corrupt session and warns instead of silent null", () => {
		expect(session).toContain('SESSION_PATH + ".corrupt-"');
		expect(session).toContain("renameSync(SESSION_PATH, aside)");
		expect(session).toContain("console.warn");
	});

	it("a <recalled_memory>-backed answer skips the gates ONLY on the first turn (scoped bypass)", () => {
		// the guard that detects an injected recalled-memory block
		expect(engine).toContain('m.content.includes("<recalled_memory>")');
		// bypass is now scoped to iteration <= 1 — a recall early in a long
		// session must not disable grounding for every later, unrelated answer
		expect(engine).toContain("iteration <= 1 && this.messages.some(");
		// act-before-answer push is suppressed when memory-backed
		expect(engine).toContain("!this.isSmallTalk(goal) && !memoryBacked");
		// filesystem verify chase is suppressed when memory-backed
		expect(engine).toContain(
			"!verifyChecked && this.tools.length > 0 && !memoryBacked",
		);
	});

	it("escalates on a FAILED OUTCOME, not only on a stuck loop", () => {
		// measured on qwen2.5:3b: right judgement in the prose, urgent.txt never
		// written — non-empty and un-"Stopped:", so the model chain never engaged
		expect(engine).toContain("return !artifactProduced(this.activeGoal);");
		// the artifact check is one helper, used by the in-loop force AND the
		// post-run escalation gate
		expect(engine).toContain("function artifactProduced(");
		expect(engine).toContain("if (!artifactProduced(goal, wanted)) {");
	});

	it("#10 parses each streamed tool call's args in its own try", () => {
		expect(engine).toContain("try { input = JSON.parse(a.args || ");
		expect(engine).toContain("} catch { continue; }");
	});
});

// P1 (codex map §6b): the generated harness now reads the USER's project
// instructions. Before this it read none — an agent run inside a repo that
// documents its conventions ignored them completely.
describe("generated harness — project instructions", () => {
	const instructions = HARNESS_INSTRUCTIONS;

	it("emits an instructions module the engine imports", () => {
		expect(instructions).toContain("export function projectInstructionsBlock");
		expect(instructions).toContain('["AGENTS.md", "CLAUDE.md"]');
		expect(engine).toContain(
			'import { projectInstructionsBlock } from "./instructions.ts"',
		);
		expect(engine).toContain("+ projectInstructionsBlock();");
	});

	it("walks upward, stops at the git root, and orders deeper files last", () => {
		expect(instructions).toContain('existsSync(join(dir, ".git"))');
		// collected deepest-first, reversed so a deeper file's text wins
		expect(instructions).toContain("return found.reverse();");
	});

	it("caps how much of a repo's docs can evict the agent's identity", () => {
		expect(instructions).toContain("MAX_INSTRUCTION_CHARS = 6000");
	});
});
