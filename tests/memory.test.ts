import { describe, expect, it } from "vitest";
import type { HarnessPlan } from "../src/builder";
import { HARNESS_MEMORY } from "../src/builder/assemble/harness-templates";

// The memory module ships as a template string emitted into the generated
// harness, where it runs under Bun (it imports bun:sqlite, so it cannot be
// imported here under Node/vitest). These assertions guard the emitted STRING:
// structure + the newline escaping that previously collapsed in template
// literals. Functional save/recall is verified by building a harness and
// running it under Bun; here we protect against silent template regressions.
const code = HARNESS_MEMORY({ name: "testagent" } as HarnessPlan);

describe("HARNESS_MEMORY template", () => {
	it("emits both memory tiers and the store class", () => {
		expect(code).toContain("class MemoryStore");
		expect(code).toContain("CREATE TABLE IF NOT EXISTS semantic");
		expect(code).toContain("CREATE TABLE IF NOT EXISTS episodic");
		expect(code).toContain("saveFact");
		expect(code).toContain("saveEvent");
		expect(code).toContain("recall(query: string");
	});

	it("bakes the plan name into the DB path", () => {
		expect(code).toContain('".testagent", "memory.db"');
	});

	it("wires the sovereign off switch", () => {
		expect(code).toContain('process.env.HARNAGE_MEMORY === "off"');
	});

	it("emits an escaped newline, not a collapsed literal linebreak", () => {
		// Must be the two characters backslash-n inside the join, so the emitted
		// file contains \n rather than a real newline that would break the string.
		expect(code).toContain('lines.join("\\n")');
		expect(code).not.toContain('lines.join("\n")');
	});
});
