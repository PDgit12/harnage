import { describe, expect, it } from "vitest";
import { paramsOf } from "../src/builder/models/catalog";
import { characterizeModel } from "../src/builder/models/characterize";
import type { Provider } from "../src/services/api/client";

// Characterization decides the scaffold a harness is generated with, so its
// failure modes matter more than its happy path: a wrong "everything is fine"
// silently ships a worse harness, and a crash must never cost a build.
function stubProvider(reply: (prompt: string) => string): Provider {
	return {
		async *stream(messages: Array<{ role: string; content: string }>) {
			const prompt = messages[messages.length - 1]?.content ?? "";
			yield { type: "text" as const, content: reply(prompt) };
		},
	} as unknown as Provider;
}

describe("characterizeModel", () => {
	it("recognises a capable model and changes nothing", async () => {
		const c = await characterizeModel(
			stubProvider((p) => {
				if (p.includes("file_read"))
					return '{"action":"tool","tool":"file_read","args":{"path":"a.ts"}}';
				if (p.includes("formatName")) return "src/util/format.ts";
				return '{"action":"tool","tool":"file_write","args":{"path":"hello.txt","content":"HELLO"}}';
			}),
		);
		expect(c.json).toBe(true);
		expect(c.pathFidelity).toBe(true);
		expect(c.acts).toBe(true);
		// A capable model must not be "fixed".
		expect(c.override).toEqual({});
	});

	it("detects the describe-instead-of-act failure", async () => {
		// Verbatim shape of the real qwen2.5:3b failure that broke code:write.
		const c = await characterizeModel(
			stubProvider((p) => {
				if (p.includes("file_read"))
					return '{"action":"tool","tool":"file_read","args":{"path":"a.ts"}}';
				if (p.includes("formatName")) return "src/util/format.ts";
				return 'To create the file, run `echo "HELLO" > hello.txt` in your terminal.';
			}),
		);
		expect(c.acts).toBe(false);
		expect(c.override.nudge).toBe(true);
		expect(c.override.loop).toBe("pipeline");
	});

	it("detects invented paths", async () => {
		const c = await characterizeModel(
			stubProvider((p) => {
				if (p.includes("formatName")) return "./src/format.ts"; // invented
				if (p.includes("file_read"))
					return '{"action":"tool","tool":"file_read","args":{"path":"a.ts"}}';
				return '{"action":"tool","tool":"file_write","args":{"path":"hello.txt","content":"HELLO"}}';
			}),
		);
		expect(c.pathFidelity).toBe(false);
		expect(c.override.temperature).toBe(0);
		expect(c.override.maxTools).toBeLessThanOrEqual(4);
	});

	it("detects a model that cannot hold a JSON shape", async () => {
		const c = await characterizeModel(
			stubProvider(() => "Sure! Happy to help."),
		);
		expect(c.json).toBe(false);
		expect(c.override.loop).toBe("pipeline");
		expect(c.override.maxTools).toBeLessThanOrEqual(4);
	});

	it("returns an EMPTY override when the model is unreachable", async () => {
		// The critical safety property: characterization must never make a build
		// worse than skipping it, so a dead endpoint changes nothing.
		const dead = {
			async *stream() {
				throw new Error("connection refused");
			},
		} as unknown as Provider;
		const c = await characterizeModel(dead);
		expect(c.completed).toBe(0);
		expect(c.override).toEqual({});
	});

	it("does not hang a build on a stalled model", async () => {
		const stalled = {
			async *stream() {
				await new Promise((r) => setTimeout(r, 5_000));
				yield { type: "text" as const, content: "too late" };
			},
		} as unknown as Provider;
		const c = await characterizeModel(stalled, { timeoutMs: 50 });
		expect(c.completed).toBe(0);
		expect(c.override).toEqual({});
	});
});

// Size resolution is what puts a model in a band, and the band decides its
// whole scaffold. `:latest` is how most people pull a model, so a tag with no
// parameter count is the COMMON case, not an edge one — llama3:latest was
// landing on the generic unknown-size default despite being a known 8B.
describe("paramsOf — size resolution for untagged models", () => {
	it("reads an explicit size from the tag", () => {
		expect(paramsOf("qwen2.5:14b")).toBe(14);
		expect(paramsOf("qwen2.5-coder:1.5b")).toBe(1.5);
		expect(paramsOf("llama3.2:1b")).toBe(1);
	});

	it("resolves known families that carry no size", () => {
		expect(paramsOf("llama3:latest")).toBe(8);
		expect(paramsOf("llama3")).toBe(8);
		expect(paramsOf("llama3.2")).toBe(3);
		expect(paramsOf("mistral")).toBe(7);
		expect(paramsOf("gemma2:latest")).toBe(9);
		expect(paramsOf("phi3")).toBe(3.8);
	});

	it("prefers an explicit tag over the defaults table", () => {
		// llama3 defaults to 8B, but llama3:70b is not an 8B model.
		expect(paramsOf("llama3:70b")).toBe(70);
	});

	it("returns 0 for a genuinely unknown model rather than guessing", () => {
		// A wrong guess silently ships the wrong scaffold; 0 means "fall back to
		// the safe mid defaults", which is the honest answer.
		expect(paramsOf("some-random-model:latest")).toBe(0);
		expect(paramsOf("")).toBe(0);
	});
});
