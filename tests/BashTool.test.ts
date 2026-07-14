import { describe, expect, it } from "vitest";
import {
	isDangerousCommand,
	isReadOnlyCommand,
} from "../src/tools/BashTool/BashTool";

describe("BashTool utils", () => {
	it("isReadOnlyCommand returns true for read commands", () => {
		expect(isReadOnlyCommand("ls")).toBe(true);
		expect(isReadOnlyCommand("cat file.txt")).toBe(true);
		expect(isReadOnlyCommand("git status")).toBe(true);
	});

	it("isReadOnlyCommand returns false for write commands", () => {
		expect(isReadOnlyCommand("rm file.txt")).toBe(false);
		expect(isReadOnlyCommand("mv a b")).toBe(false);
		expect(isReadOnlyCommand("git push")).toBe(false);
	});

	it("isDangerousCommand rejects rm -rf /", () => {
		const result = isDangerousCommand("rm -rf /");
		expect(result.valid).toBe(false);
		expect(result.error).toBe("Recursive root delete");
	});

	it("isDangerousCommand allows safe commands", () => {
		expect(isDangerousCommand("ls").valid).toBe(true);
	});

	it("handles undefined command gracefully (LLM sends cmd instead of command)", () => {
		expect(isReadOnlyCommand(undefined as unknown as string)).toBe(true);
		expect(isDangerousCommand(undefined as unknown as string).valid).toBe(true);
	});
});
