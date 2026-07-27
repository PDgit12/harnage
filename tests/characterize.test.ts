import { describe, expect, it } from "vitest";
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
