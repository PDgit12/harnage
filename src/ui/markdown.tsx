import { Box, Text } from "ink";
import { ACCENT, GLYPHS } from "./brand";

// The model replies in markdown. Ink renders raw text, so without this a
// response shows literal `##`, `|`, and ``` fences — the single biggest reason
// the TUI looked "sloppy". This is a deliberately small markdown subset (the
// blocks a chat/agent reply actually uses), rendered as styled Ink, not a full
// CommonMark implementation.

export type InlineSpan = {
	text: string;
	bold?: boolean;
	italic?: boolean;
	code?: boolean;
};

export type Block =
	| { type: "heading"; level: number; spans: InlineSpan[] }
	| { type: "code"; lang: string; lines: string[] }
	| { type: "list"; ordered: boolean; items: InlineSpan[][] }
	| { type: "quote"; spans: InlineSpan[][] }
	| { type: "hr" }
	| { type: "para"; spans: InlineSpan[] };

// Split a line into styled inline spans: **bold**, *italic*/_italic_, `code`.
// Single-pass tokenizer — nested emphasis is not supported (rare in agent
// replies and not worth the complexity); the delimiters just render literally
// if unbalanced.
export function parseInline(line: string): InlineSpan[] {
	const spans: InlineSpan[] = [];
	let i = 0;
	let plain = "";
	const flush = () => {
		if (plain) {
			spans.push({ text: plain });
			plain = "";
		}
	};
	while (i < line.length) {
		const two = line.slice(i, i + 2);
		if (two === "**") {
			const end = line.indexOf("**", i + 2);
			if (end !== -1) {
				flush();
				spans.push({ text: line.slice(i + 2, end), bold: true });
				i = end + 2;
				continue;
			}
		}
		const ch = line[i];
		if (ch === "`") {
			const end = line.indexOf("`", i + 1);
			if (end !== -1) {
				flush();
				spans.push({ text: line.slice(i + 1, end), code: true });
				i = end + 1;
				continue;
			}
		}
		if ((ch === "*" || ch === "_") && line[i + 1] !== ch) {
			const end = line.indexOf(ch, i + 1);
			if (end !== -1 && end > i + 1) {
				flush();
				spans.push({ text: line.slice(i + 1, end), italic: true });
				i = end + 1;
				continue;
			}
		}
		plain += ch;
		i++;
	}
	flush();
	return spans.length ? spans : [{ text: "" }];
}

export function parseBlocks(text: string): Block[] {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const blocks: Block[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();

		// fenced code block
		const fence = trimmed.match(/^```(\w*)$/);
		if (fence) {
			const lang = fence[1] ?? "";
			const body: string[] = [];
			i++;
			while (i < lines.length && lines[i].trim() !== "```") {
				body.push(lines[i]);
				i++;
			}
			i++; // consume closing fence
			blocks.push({ type: "code", lang, lines: body });
			continue;
		}

		if (trimmed === "") {
			i++;
			continue;
		}

		// horizontal rule
		if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
			blocks.push({ type: "hr" });
			i++;
			continue;
		}

		// heading
		const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
		if (heading) {
			blocks.push({
				type: "heading",
				level: heading[1].length,
				spans: parseInline(heading[2]),
			});
			i++;
			continue;
		}

		// blockquote (consecutive > lines)
		if (/^>\s?/.test(trimmed)) {
			const quote: InlineSpan[][] = [];
			while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
				quote.push(parseInline(lines[i].trim().replace(/^>\s?/, "")));
				i++;
			}
			blocks.push({ type: "quote", spans: quote });
			continue;
		}

		// list (consecutive bullet or ordered lines)
		if (/^([-*+]\s+|\d+\.\s+)/.test(trimmed)) {
			const ordered = /^\d+\.\s+/.test(trimmed);
			const items: InlineSpan[][] = [];
			while (i < lines.length && /^([-*+]\s+|\d+\.\s+)/.test(lines[i].trim())) {
				const item = lines[i].trim().replace(/^([-*+]\s+|\d+\.\s+)/, "");
				items.push(parseInline(item));
				i++;
			}
			blocks.push({ type: "list", ordered, items });
			continue;
		}

		// paragraph (accumulate until blank / block boundary)
		const para: string[] = [];
		while (
			i < lines.length &&
			lines[i].trim() !== "" &&
			!/^```/.test(lines[i].trim()) &&
			!/^#{1,6}\s+/.test(lines[i].trim()) &&
			!/^([-*+]\s+|\d+\.\s+)/.test(lines[i].trim()) &&
			!/^>\s?/.test(lines[i].trim()) &&
			!/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim())
		) {
			para.push(lines[i].trim());
			i++;
		}
		blocks.push({ type: "para", spans: parseInline(para.join(" ")) });
	}

	return blocks;
}

function Inline({ spans }: { spans: InlineSpan[] }) {
	return (
		<Text>
			{spans.map((s, i) => (
				<Text
					// biome-ignore lint/suspicious/noArrayIndexKey: spans are positional, never reordered
					key={i}
					bold={s.bold}
					italic={s.italic}
					color={s.code ? ACCENT : undefined}
				>
					{s.text}
				</Text>
			))}
		</Text>
	);
}

export function Markdown({ text }: { text: string }) {
	const blocks = parseBlocks(text);
	return (
		<Box flexDirection="column">
			{blocks.map((b, i) => {
				const key = i;
				if (b.type === "heading") {
					return (
						<Box key={key} marginTop={i > 0 ? 1 : 0}>
							<Text bold color={ACCENT}>
								<Inline spans={b.spans} />
							</Text>
						</Box>
					);
				}
				if (b.type === "code") {
					return (
						<Box
							key={key}
							flexDirection="column"
							borderStyle="round"
							borderColor="gray"
							paddingLeft={1}
							paddingRight={1}
							marginY={i > 0 ? 1 : 0}
						>
							{b.lines.map((ln, j) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: code lines are positional
								<Text key={j} color="green">
									{ln || " "}
								</Text>
							))}
						</Box>
					);
				}
				if (b.type === "list") {
					return (
						<Box key={key} flexDirection="column">
							{b.items.map((item, j) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: list items are positional
								<Box key={j}>
									{/* marginRight, not a trailing space: Ink flexbox collapses a
									    trailing space in one Text when another follows on the row,
									    which made bullet gaps inconsistent ("· a" vs "·b"). */}
									<Box marginRight={1}>
										<Text color={ACCENT}>
											{b.ordered ? `${j + 1}.` : GLYPHS.bullet}
										</Text>
									</Box>
									<Inline spans={item} />
								</Box>
							))}
						</Box>
					);
				}
				if (b.type === "quote") {
					return (
						<Box key={key} flexDirection="column">
							{b.spans.map((ln, j) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: quote lines are positional
								<Box key={j}>
									<Text color="gray">{"│ "}</Text>
									<Text dimColor>
										<Inline spans={ln} />
									</Text>
								</Box>
							))}
						</Box>
					);
				}
				if (b.type === "hr") {
					return (
						<Text key={key} dimColor>
							{"─".repeat(40)}
						</Text>
					);
				}
				return (
					<Box key={key}>
						<Inline spans={b.spans} />
					</Box>
				);
			})}
		</Box>
	);
}
