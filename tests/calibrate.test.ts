import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildHarness } from "../src/builder/index";
import { COMMAND_TEMPLATES } from "../src/builder/generate/command-generator";
import { HARNESS_PROFILES } from "../src/builder/assemble/harness-templates";

// The calibrate command template ships inside every generated harness (see
// command-generator.ts's generateCommandFiles force-write list, mirroring
// model/cost/doctor). A syntax error inside the template string would only
// surface once a real build ran it through tsc — transpileModule catches it
// here for free, at unit-test speed (no relative-import resolution needed).
describe("calibrate command template", () => {
	it("is syntactically valid TypeScript", async () => {
		const ts = await import("typescript");
		const result = ts.transpileModule(COMMAND_TEMPLATES.calibrate, {
			reportDiagnostics: true,
			compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
		});
		const syntaxErrors = (result.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
		expect(syntaxErrors).toHaveLength(0);
	});

	it("writes the winning profile to ~/.<name>/profile.json with measured overrides only", () => {
		expect(COMMAND_TEMPLATES.calibrate).toContain("profile.json");
		expect(COMMAND_TEMPLATES.calibrate).toContain("loop: winner.loop");
		expect(COMMAND_TEMPLATES.calibrate).toContain("editFormat: winner.editFormat");
	});

	it("is force-written into every generated harness like doctor/cost/model", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "calibrate-build-"));
		try {
			const result = await buildHarness("a simple test agent", tmpDir, () => {});
			expect(result.success).toBe(true);
			const calibratePath = join(result.outputDir, "src", "commands", "calibrate.ts");
			const contents = readFileSync(calibratePath, "utf-8");
			expect(contents).toContain("resolveProfile");
			expect(contents).toContain("LoopEngine");
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}, 300_000);
});

// resolveProfile's measured>baked>base merge. HARNESS_PROFILES is written to a
// temp file and imported so this exercises the REAL resolver, same convention
// as profiles.test.ts's baked-override suite — the calibration file path is
// derived from the harness name passed as HARNESS_PROFILES's second argument.
describe("resolveProfile — measured calibration merge", () => {
	it("merges a measured profile.json on top of a baked override", async () => {
		const home = mkdtempSync(join(tmpdir(), "calibrate-home-"));
		const configDir = join(home, ".calib-harness");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "profile.json"),
			JSON.stringify({
				model: "qwen3:8b",
				profile: { loop: "pipeline", editFormat: "whole-file" },
				passCount: 5,
				totalTasks: 5,
				calibratedAt: new Date().toISOString(),
			}),
		);

		const originalHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const dir = mkdtempSync(join(tmpdir(), "profiles-measured-"));
			const file = join(dir, "profiles.ts");
			writeFileSync(
				file,
				HARNESS_PROFILES({ "qwen3:8b": { loop: "free", toolCalling: "native", maxTools: 8 } }, "calib-harness"),
			);
			const { resolveProfile } = (await import(file)) as {
				resolveProfile: (m: string) => { loop: string; editFormat: string; toolCalling: string; maxTools: number };
			};
			const p = resolveProfile("qwen3:8b");
			// measured (loop: pipeline, editFormat: whole-file) wins over baked (loop: free)
			expect(p.loop).toBe("pipeline");
			expect(p.editFormat).toBe("whole-file");
			// fields the measurement didn't touch keep the baked override
			expect(p.toolCalling).toBe("native");
			expect(p.maxTools).toBe(8);
		} finally {
			process.env.HOME = originalHome;
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("falls back to base+baked behavior when profile.json is missing", async () => {
		const home = mkdtempSync(join(tmpdir(), "calibrate-home-missing-"));
		const originalHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const dir = mkdtempSync(join(tmpdir(), "profiles-missing-"));
			const file = join(dir, "profiles.ts");
			writeFileSync(file, HARNESS_PROFILES({}, "calib-harness-missing"));
			const { resolveProfile } = (await import(file)) as {
				resolveProfile: (m: string) => { loop: string; tier: string };
			};
			const p = resolveProfile("qwen3:8b");
			expect(p.tier).toBe("mid");
			expect(p.loop).toBe("plan-act");
		} finally {
			process.env.HOME = originalHome;
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("falls back cleanly when profile.json is corrupt JSON", async () => {
		const home = mkdtempSync(join(tmpdir(), "calibrate-home-corrupt-"));
		const configDir = join(home, ".calib-harness-corrupt");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "profile.json"), "{ not valid json");
		const originalHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const dir = mkdtempSync(join(tmpdir(), "profiles-corrupt-"));
			const file = join(dir, "profiles.ts");
			writeFileSync(file, HARNESS_PROFILES({}, "calib-harness-corrupt"));
			const { resolveProfile } = (await import(file)) as {
				resolveProfile: (m: string) => { loop: string; tier: string };
			};
			const p = resolveProfile("qwen2.5:3b");
			expect(p.tier).toBe("small");
		} finally {
			process.env.HOME = originalHome;
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("leaves an unrelated model's profile untouched by another model's calibration", async () => {
		const home = mkdtempSync(join(tmpdir(), "calibrate-home-other-"));
		const configDir = join(home, ".calib-harness-other");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "profile.json"),
			JSON.stringify({
				model: "qwen3:8b",
				profile: { loop: "pipeline", editFormat: "whole-file" },
				passCount: 5,
				totalTasks: 5,
				calibratedAt: new Date().toISOString(),
			}),
		);
		const originalHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const dir = mkdtempSync(join(tmpdir(), "profiles-other-"));
			const file = join(dir, "profiles.ts");
			writeFileSync(file, HARNESS_PROFILES({}, "calib-harness-other"));
			const { resolveProfile } = (await import(file)) as {
				resolveProfile: (m: string) => { loop: string; tier: string };
			};
			const p = resolveProfile("mistral:7b");
			expect(p.tier).toBe("mid");
			expect(p.loop).toBe("plan-act");
		} finally {
			process.env.HOME = originalHome;
			rmSync(home, { recursive: true, force: true });
		}
	});
});
