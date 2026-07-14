import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildResult } from "../src/builder/assemble";
import type { HarnessPlan } from "../src/builder/index";
import type { Provider } from "../src/services/api/client";

// Mock verifyBuild so repair tests never run real bun install/tsc.
const verifyBuildMock = vi.fn();
vi.mock("../src/builder/assemble", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../src/builder/assemble")>();
	return {
		...mod,
		verifyBuild: (...args: unknown[]) => verifyBuildMock(...args),
	};
});

const { repairLoop } = await import("../src/builder/llm/repair");

function mockProvider(responses: string[]): Provider {
	let i = 0;
	return {
		async *stream() {
			const text = responses[Math.min(i, responses.length - 1)];
			i++;
			yield { type: "text", content: text };
			yield { type: "done" };
		},
	};
}

const plan: HarnessPlan = {
	name: "t",
	description: "t",
	tools: ["bash"],
	commands: [],
	providers: ["ollama"],
	systemPrompt: "x".repeat(60),
	hasMcp: false,
};

function failedResult(outputDir: string, errors: string[]): BuildResult {
	return { success: false, outputDir, errors };
}

function patchJSON(path: string, content: string): string {
	return JSON.stringify({
		analysis: "the file has a syntax error",
		patches: [{ path, newContent: content }],
	});
}

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "repair-test-"));
	verifyBuildMock.mockReset();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("repairLoop", () => {
	it("applies a patch inside outputDir and re-verifies", async () => {
		await writeFile(join(dir, "broken.ts"), "const x: number = 'no';");
		verifyBuildMock.mockResolvedValue({
			success: true,
			outputDir: dir,
			errors: [],
		});

		const provider = mockProvider([
			patchJSON("broken.ts", "const x: number = 1;"),
		]);
		const first = failedResult(dir, [
			"TypeScript build failed: broken.ts(1,7): error TS2322",
		]);
		const { result, repairsUsed } = await repairLoop(
			provider,
			plan,
			first,
			dir,
			undefined,
			2,
		);

		expect(result.success).toBe(true);
		expect(repairsUsed).toBe(1);
		expect(verifyBuildMock).toHaveBeenCalledTimes(1);
		expect(await readFile(join(dir, "broken.ts"), "utf-8")).toBe(
			"const x: number = 1;",
		);
	});

	it("rejects path-escape patches and stops without verifying", async () => {
		const provider = mockProvider([
			JSON.stringify({
				analysis: "escape attempt",
				patches: [
					{ path: "../evil.ts", newContent: "evil" },
					{ path: "/etc/x", newContent: "evil" },
				],
			}),
		]);
		const first = failedResult(dir, ["TypeScript build failed: src/a.ts(1,1)"]);
		const { result, repairsUsed } = await repairLoop(
			provider,
			plan,
			first,
			dir,
			undefined,
			2,
		);

		expect(result.success).toBe(false);
		expect(repairsUsed).toBe(1);
		expect(verifyBuildMock).not.toHaveBeenCalled();
	});

	it("stops at maxRepairs when build stays red", async () => {
		await writeFile(join(dir, "b.ts"), "bad");
		verifyBuildMock.mockResolvedValue(
			failedResult(dir, ["TypeScript build failed: b.ts(1,1): error TS1109"]),
		);
		const provider = mockProvider([patchJSON("b.ts", "still bad")]);
		const first = failedResult(dir, [
			"TypeScript build failed: b.ts(1,1): error TS1109",
		]);
		const { result, repairsUsed } = await repairLoop(
			provider,
			plan,
			first,
			dir,
			undefined,
			2,
		);

		expect(result.success).toBe(false);
		expect(repairsUsed).toBe(2);
		expect(verifyBuildMock).toHaveBeenCalledTimes(2);
	});

	it("succeeds on second iteration", async () => {
		await writeFile(join(dir, "c.ts"), "bad");
		verifyBuildMock
			.mockResolvedValueOnce(
				failedResult(dir, ["TypeScript build failed: c.ts(1,1): error TS1109"]),
			)
			.mockResolvedValueOnce({ success: true, outputDir: dir, errors: [] });
		const provider = mockProvider([
			patchJSON("c.ts", "attempt 1"),
			patchJSON("c.ts", "attempt 2"),
		]);
		const first = failedResult(dir, [
			"TypeScript build failed: c.ts(1,1): error TS1109",
		]);
		const { result, repairsUsed } = await repairLoop(
			provider,
			plan,
			first,
			dir,
			undefined,
			3,
		);

		expect(result.success).toBe(true);
		expect(repairsUsed).toBe(2);
		expect(await readFile(join(dir, "c.ts"), "utf-8")).toBe("attempt 2");
	});
});
