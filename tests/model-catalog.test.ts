import { describe, expect, it } from "vitest";
import {
	classifyDomain,
	inferFamily,
	maxParamsForRam,
	recommendModels,
} from "../src/builder/models/catalog";

describe("classifyDomain", () => {
	it("maps prompts to a work type", () => {
		expect(classifyDomain("a code review agent that reads a diff")).toBe(
			"review",
		);
		expect(classifyDomain("inspect and edit a TypeScript codebase")).toBe(
			"code",
		);
		expect(classifyDomain("clean CSV files and dedupe rows")).toBe("data");
		expect(classifyDomain("answer questions about the README")).toBe("docs");
		expect(classifyDomain("a helpful assistant")).toBe("general");
	});
});

describe("maxParamsForRam", () => {
	it("caps params by RAM tier", () => {
		expect(maxParamsForRam(8)).toBe(4);
		expect(maxParamsForRam(16)).toBe(8);
		expect(maxParamsForRam(32)).toBe(14);
		expect(maxParamsForRam(96)).toBe(70);
	});
});

describe("inferFamily", () => {
	it("reads size, family, coder, tool-tuning from an id", () => {
		expect(inferFamily("qwen2.5-coder:7b")).toMatchObject({
			params: 7,
			family: "qwen",
			isCoder: true,
			toolTuned: true,
		});
		expect(inferFamily("mistral:7b")).toMatchObject({
			params: 7,
			family: "mistral",
			isCoder: false,
		});
		expect(inferFamily("something-weird:latest").family).toBe("unknown");
	});
});

describe("recommendModels", () => {
	it("recommends code models for a code agent on 16GB, all fitting RAM", () => {
		const recs = recommendModels("code", 16, []);
		expect(recs.length).toBeGreaterThan(0);
		expect(recs.every((r) => r.params <= 8)).toBe(true); // 16GB → ≤8B
		expect(recs[0].domains).toContain("code"); // domain-specific ranked first
	});

	it("marks installed models and surfaces uncurated installed ones", () => {
		const recs = recommendModels("general", 16, [
			"qwen2.5:3b",
			"my-custom-tune:7b",
		]);
		expect(recs.find((r) => r.id === "qwen2.5:3b")?.installed).toBe(true);
		const tail = recs.find((r) => r.id === "my-custom-tune:7b");
		expect(tail).toBeDefined();
		expect(tail?.source).toBe("installed");
	});

	it("excludes models too big for the RAM tier", () => {
		const recs = recommendModels("code", 8, []); // ≤4B
		expect(recs.every((r) => r.params <= 4)).toBe(true);
	});
});
