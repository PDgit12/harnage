import { describe, expect, it } from "vitest";
import type { HarnessPlan } from "../src/builder";
import {
	ENGINE_TEMPLATE,
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

	it("#10 parses each streamed tool call's args in its own try", () => {
		expect(engine).toContain(
			"try { input = JSON.parse(a.args || ",
		);
		expect(engine).toContain("} catch { continue; }");
	});
});
