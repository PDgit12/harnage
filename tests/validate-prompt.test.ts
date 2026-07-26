import { describe, expect, it } from "vitest";
import { validateAgentPrompt } from "../src/builder/spec/index";

const accepts = (p: string) => expect(() => validateAgentPrompt(p)).not.toThrow();
const rejects = (p: string) => expect(() => validateAgentPrompt(p)).toThrow();

describe("validateAgentPrompt — permissive: a task description is a valid agent", () => {
	it("accepts task descriptions whose verb isn't a magic keyword", () => {
		// These were all REJECTED by the old keyword whitelist (triage, rank,
		// draft aren't on it) despite being perfectly valid harnesses.
		accepts("triage customer support tickets by urgency and product area");
		accepts("analyze github repos and rank them for product-market fit");
		accepts("draft release changelogs from git history");
		accepts("categorize incoming invoices and flag anomalies");
	});

	it("accepts an agent-framed version of an 'app' domain", () => {
		accepts("an agent that drafts blog posts");
		accepts("an agent that monitors my store's reviews and flags issues");
	});

	it("rejects a bare app/product request with no agent framing", () => {
		rejects("a todo app");
		rejects("build me an ecommerce store");
	});

	it("rejects empty / too-short input", () => {
		rejects("hi");
		rejects("");
	});
});
