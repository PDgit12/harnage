import { describe, expect, it } from "vitest";
import type { HarnessPlan } from "../src/builder";
import { ENGINE_TEMPLATE } from "../src/builder/assemble/harness-templates";

// Bounded chassis knobs from the plan are baked into the generated engine as a
// CONFIG constant. These guard the interpolation + wiring (compilation is
// covered by the offline generated-harness E2E build).
describe("ENGINE_TEMPLATE chassis config", () => {
	it("bakes plan.config into the CONFIG constant", () => {
		const code = ENGINE_TEMPLATE({
			name: "a",
			config: {
				maxIterations: 7,
				memory: false,
				eval: true,
				judgeByDefault: true,
			},
		} as HarnessPlan);
		expect(code).toContain("maxIterations: 7");
		expect(code).toContain("memory: false");
		expect(code).toContain("judgeByDefault: true");
	});

	it("falls back to safe defaults when no config is planned", () => {
		const code = ENGINE_TEMPLATE({ name: "b" } as HarnessPlan);
		expect(code).toContain("maxIterations: 20");
		expect(code).toContain("memory: true");
		expect(code).toContain("eval: true");
		expect(code).toContain("judgeByDefault: false");
	});

	it("wires the constant into the safety cap and subsystem gates", () => {
		const code = ENGINE_TEMPLATE({ name: "c" } as HarnessPlan);
		expect(code).toContain(
			"this.safety.check(iteration, CONFIG.maxIterations)",
		);
		expect(code).toContain("this.persistSession && CONFIG.memory");
		expect(code).toContain("this.persistSession && CONFIG.eval");
	});
});
