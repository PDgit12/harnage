import { describe, expect, it } from "vitest";
import { pickTheme } from "../src/builder/theme";

describe("pickTheme — per-domain accent, same chassis", () => {
	it("maps domains to distinct accent hues", () => {
		expect(pickTheme("reviews PRs for security vulnerabilities").accent).toBe(
			"#ef4444",
		); // red
		expect(pickTheme("a finance invoice and revenue tracker").accent).toBe(
			"#22c55e",
		); // green
		expect(pickTheme("clean and dedup CSV datasets with SQL").accent).toBe(
			"#3b82f6",
		); // blue
		expect(pickTheme("a creative marketing copy generator").accent).toBe(
			"#a855f7",
		); // purple
	});

	it("gives an unmatched domain a deterministic, non-default fallback color", () => {
		const a = pickTheme("a widget frobnicator agent");
		const b = pickTheme("a widget frobnicator agent");
		expect(a).toEqual(b); // deterministic across rebuilds
		expect(a.accent).toMatch(/^#[0-9a-f]{6}$/);
	});

	it("always returns a darker dim variant for the wordmark gradient", () => {
		const t = pickTheme("anything");
		expect(t.accentDim).toMatch(/^#[0-9a-f]{6}$/);
		expect(t.accentDim).not.toBe(t.accent);
	});
});
