import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HARNESS_PROFILES } from "../src/builder/assemble/harness-templates";

// The profiles module ships as a template string inside the generated harness.
// Writing it to a temp .ts file and importing it exercises the real resolver
// AND doubles as an escaping check — a broken template fails to import here.
const dir = mkdtempSync(join(tmpdir(), "profiles-"));
const file = join(dir, "profiles.ts");
writeFileSync(file, HARNESS_PROFILES());
const { resolveProfile } = (await import(file)) as {
	resolveProfile: (
		model: string,
		contextTokens?: number,
	) => {
		tier: string;
		loop: string;
		toolCalling: string;
		maxTools: number;
		nudge: boolean;
		contextTokens: number;
	};
};

describe("resolveProfile", () => {
	it("routes frontier hosted models to a free native loop", () => {
		const p = resolveProfile("claude-sonnet-5");
		expect(p.tier).toBe("frontier");
		expect(p.loop).toBe("free");
		expect(p.toolCalling).toBe("native");
		expect(p.nudge).toBe(true);
	});

	it("routes large local models (>=13B) to strong native", () => {
		const p = resolveProfile("qwen2.5:32b");
		expect(p.tier).toBe("strong");
		expect(p.toolCalling).toBe("native");
	});

	it("routes 8B models to mid plan-act + constrained-json", () => {
		const p = resolveProfile("qwen3:8b");
		expect(p.tier).toBe("mid");
		expect(p.loop).toBe("plan-act");
		expect(p.toolCalling).toBe("constrained-json");
		expect(p.maxTools).toBe(5);
		expect(p.nudge).toBe(false);
	});

	it("routes small (<=3B) models to a constrained-json pipeline", () => {
		const p = resolveProfile("qwen2.5:3b");
		expect(p.tier).toBe("small");
		expect(p.loop).toBe("pipeline");
		expect(p.toolCalling).toBe("constrained-json");
		expect(p.maxTools).toBe(4);
	});

	it("routes known small families without a size tag to small", () => {
		expect(resolveProfile("phi").tier).toBe("small");
		expect(resolveProfile("llama3.2").tier).toBe("small");
	});

	it("falls back to the mid default for unknown models", () => {
		const p = resolveProfile("some-random-model");
		expect(p.tier).toBe("mid");
		expect(p.loop).toBe("plan-act");
	});

	it("threads contextTokens through", () => {
		expect(resolveProfile("claude", 32768).contextTokens).toBe(32768);
		expect(resolveProfile("qwen3:8b").contextTokens).toBe(8192);
	});
});

// Baked per-model overrides: qwen3:8b would be mid/constrained by size, but a
// catalog override earns it the free native loop — merged on top of the tier.
const bakedDir = mkdtempSync(join(tmpdir(), "profiles-baked-"));
const bakedFile = join(bakedDir, "profiles.ts");
writeFileSync(
	bakedFile,
	HARNESS_PROFILES({
		"qwen3:8b": { loop: "free", toolCalling: "native", maxTools: 8 },
	}),
);
const baked = (await import(bakedFile)) as {
	resolveProfile: (m: string) => { loop: string; toolCalling: string; maxTools: number; tier: string };
};

describe("baked per-model overrides", () => {
	it("merges overrides on top of the size-tier profile", () => {
		const p = baked.resolveProfile("qwen3:8b");
		expect(p.toolCalling).toBe("native"); // overridden from constrained-json
		expect(p.loop).toBe("free"); // overridden from plan-act
		expect(p.maxTools).toBe(8);
	});
	it("leaves un-baked models on their tier default", () => {
		const p = baked.resolveProfile("mistral:7b");
		expect(p.toolCalling).toBe("constrained-json");
		expect(p.tier).toBe("mid");
	});
});
