import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessPlan } from "../src/builder";
import { HARNESS_PERMISSIONS } from "../src/builder/assemble/harness-templates";

// The permission module ships as a template string. Set HOME to a temp dir
// BEFORE importing so POLICY_PATH resolves under it, then exercise the
// save/load round-trip that backs the TUI "always (remember)" choice.
const home = mkdtempSync(join(tmpdir(), "perm-home-"));
process.env.HOME = home;

const dir = mkdtempSync(join(tmpdir(), "perm-mod-"));
const file = join(dir, "permissions.ts");
writeFileSync(
	file,
	HARNESS_PERMISSIONS({ name: "testh" } as unknown as HarnessPlan),
);
const P = (await import(file)) as {
	loadPolicy: () => {
		mode: string;
		rules: Array<{ pattern: string; allow: boolean }>;
	};
	savePolicy: (p: {
		mode: string;
		rules: Array<{ pattern: string; allow: boolean }>;
	}) => void;
	checkPermission: (
		policy: unknown,
		tool: string,
		input: unknown,
	) => { allowed: boolean; reason?: string };
};

describe("generated permissions — remember flow", () => {
	it("denies a write with no rule in default mode", () => {
		const policy = { mode: "default", rules: [] };
		expect(
			P.checkPermission(policy, "file_write", { path: "src/x.ts" }).allowed,
		).toBe(false);
	});

	it("persists an allow rule and honors it on reload (the 'always' path)", () => {
		P.savePolicy({
			mode: "default",
			rules: [{ pattern: "file_write(src/**)", allow: true }],
		});
		const loaded = P.loadPolicy();
		expect(loaded.rules).toContainEqual({
			pattern: "file_write(src/**)",
			allow: true,
		});
		expect(
			P.checkPermission(loaded, "file_write", { path: "src/x.ts" }).allowed,
		).toBe(true);
		// a path outside the remembered glob still needs approval
		expect(
			P.checkPermission(loaded, "file_write", { path: "docs/y.md" }).allowed,
		).toBe(false);
	});
});
