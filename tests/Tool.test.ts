import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Tool } from "../src/Tool";

describe("Tool", () => {
	it("creates a valid tool object", () => {
		const tool: Tool<{ x: string }, string> = {
			name: "test",
			description: "A test tool",
			inputSchema: z.object({ x: z.string() }),
			call: async (input: { x: string }) => ({ data: input.x }),
			isReadOnly: () => false,
		};
		expect(tool.name).toBe("test");
		expect(typeof tool.call).toBe("function");
	});

	it("isReadOnly detection", () => {
		const readOnly: Tool<Record<string, never>, string> = {
			name: "reader",
			description: "Read-only tool",
			inputSchema: z.object({}),
			call: async () => ({ data: "ok" }),
			isReadOnly: () => true,
		};
		const write: Tool<Record<string, never>, string> = {
			name: "writer",
			description: "Write tool",
			inputSchema: z.object({}),
			call: async () => ({ data: "ok" }),
			isReadOnly: () => false,
		};
		expect(readOnly.isReadOnly!({} as Record<string, never>)).toBe(true);
		expect(write.isReadOnly!({} as Record<string, never>)).toBe(false);
	});

	it("Tool type accepts valid inputSchema", () => {
		const tool: Tool<Record<string, never>, string> = {
			name: "test",
			description: "Schema test",
			inputSchema: z.object({}),
			call: async () => ({ data: "ok" }),
			isReadOnly: () => false,
		};
		expect(tool.inputSchema).toBeDefined();
	});
});
