import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "../src/ui/markdown";

describe("parseInline — bold / italic / code spans", () => {
	it("splits bold, italic, and inline code", () => {
		expect(parseInline("a **b** c")).toEqual([
			{ text: "a " },
			{ text: "b", bold: true },
			{ text: " c" },
		]);
		expect(parseInline("run `bun test` now")).toEqual([
			{ text: "run " },
			{ text: "bun test", code: true },
			{ text: " now" },
		]);
		expect(parseInline("_emph_")).toEqual([{ text: "emph", italic: true }]);
	});

	it("leaves unbalanced delimiters as literal text", () => {
		expect(parseInline("2 * 3 = 6")).toEqual([{ text: "2 * 3 = 6" }]);
	});
});

describe("parseBlocks — headings, code, lists, quotes, rules", () => {
	it("parses a heading", () => {
		const b = parseBlocks("## Plan");
		expect(b).toHaveLength(1);
		expect(b[0]).toMatchObject({ type: "heading", level: 2 });
	});

	it("parses a fenced code block without treating its contents as markdown", () => {
		const b = parseBlocks("```ts\nconst x = 1;\n# not a heading\n```");
		expect(b).toHaveLength(1);
		expect(b[0]).toEqual({
			type: "code",
			lang: "ts",
			lines: ["const x = 1;", "# not a heading"],
		});
	});

	it("groups consecutive bullets into one list", () => {
		const b = parseBlocks("- one\n- two\n- three");
		expect(b).toHaveLength(1);
		expect(b[0]).toMatchObject({ type: "list", ordered: false });
		expect((b[0] as { items: unknown[] }).items).toHaveLength(3);
	});

	it("parses an ordered list", () => {
		const b = parseBlocks("1. first\n2. second");
		expect(b[0]).toMatchObject({ type: "list", ordered: true });
	});

	it("parses a blockquote and a horizontal rule", () => {
		const b = parseBlocks("> quoted\n\n---");
		expect(b[0]).toMatchObject({ type: "quote" });
		expect(b[1]).toEqual({ type: "hr" });
	});

	it("treats plain prose as a paragraph", () => {
		const b = parseBlocks("just a normal sentence.");
		expect(b[0]).toMatchObject({ type: "para" });
	});

	it("handles a realistic mixed reply", () => {
		const md = "# Title\n\nSome **bold** intro.\n\n- a\n- b\n\n```js\nfoo();\n```";
		const b = parseBlocks(md);
		expect(b.map((x) => x.type)).toEqual([
			"heading",
			"para",
			"list",
			"code",
		]);
	});
});
