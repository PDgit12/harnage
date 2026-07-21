import chalk from "chalk";
import pkg from "../../package.json";

/**
 * Signature accent — single source of truth for the wordmark, prompts,
 * active-status indicators, and borders across the classic REPL, Ink TUI,
 * and setup wizard. Semantic colors (red=error, yellow=busy, green=success,
 * magenta=command-mode) stay separate — this is the brand color only.
 */
export const ACCENT = "#22d3ee";
export const ACCENT_DIM = "#0e7490";
export const WORDMARK = "harnage";
export const TAGLINE = "AI Model = Brain · Harness = Hands";
export const VERSION = `v${pkg.version}`;

const UNICODE_SPINNER_FRAMES = [
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏",
];
const ASCII_SPINNER_FRAMES = ["|", "/", "-", "\\"];

/**
 * Best-effort unicode-terminal detection (same heuristic as the
 * `is-unicode-supported` package, hand-rolled to avoid a new dependency):
 * Windows terminals need an explicit allowlist; everywhere else, only the
 * bare Linux kernel console (TERM=linux) reliably lacks unicode glyph
 * support, so assume support unless that's set.
 *
 * HARNAGE_ASCII=1 force-disables unicode regardless of the heuristic — same
 * escape hatch name generated harnesses use (see chassis's harness-templates.ts),
 * so one env var forces plain-ASCII rendering across both the reference CLI
 * and every generated harness.
 */
export function supportsUnicode(): boolean {
	if (process.env.HARNAGE_ASCII) return false;
	if (process.platform !== "win32") {
		return process.env.TERM !== "linux";
	}
	return Boolean(
		process.env.CI ||
			process.env.WT_SESSION ||
			process.env.TERM_PROGRAM === "vscode" ||
			process.env.TERM === "xterm-256color",
	);
}

export const SPINNER_FRAMES = supportsUnicode()
	? UNICODE_SPINNER_FRAMES
	: ASCII_SPINNER_FRAMES;

/** Ink `borderStyle` for the banner/input boxes — "classic" is pure ASCII
 * (+/-/|), for terminals without unicode box-drawing support. */
export const BORDER_STYLE = supportsUnicode() ? "round" : "classic";

/** Glyphs that fall back to plain ASCII on terminals without unicode
 * support (bare Linux console, some Windows shells). */
export const GLYPHS = supportsUnicode()
	? {
			gear: "⚙",
			prompt: "❯",
			arrow: "↳",
			corner: "└",
			cross: "✖",
			pause: "⏸",
			bullet: "·",
			rule: "─",
			modeReady: "⏵⏵",
			check: "✓",
		}
	: {
			gear: "*",
			prompt: ">",
			arrow: "->",
			corner: "\\-",
			cross: "x",
			pause: "[paused]",
			bullet: "-",
			rule: "-",
			modeReady: ">>",
			check: "OK",
		};

function hexToRgb(hex: string): [number, number, number] {
	const n = Number.parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerpHex(from: string, to: string, t: number): string {
	const [r1, g1, b1] = hexToRgb(from);
	const [r2, g2, b2] = hexToRgb(to);
	const r = Math.round(r1 + (r2 - r1) * t);
	const g = Math.round(g1 + (g2 - g1) * t);
	const b = Math.round(b1 + (b2 - b1) * t);
	return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Per-character {ch, color} pairs for the wordmark gradient — feed straight
 * into Ink <Text color={c}> spans. Raw ANSI-wrapped strings would break
 * Ink's layout width calculations, so Ink and chalk consumers use this same
 * table via two different renderers (see gradientWordmark below).
 */
export function wordmarkChars(
	text: string = WORDMARK,
): Array<{ ch: string; color: string }> {
	return text.split("").map((ch, i) => ({
		ch,
		color: lerpHex(
			ACCENT,
			ACCENT_DIM,
			text.length <= 1 ? 0 : i / (text.length - 1),
		),
	}));
}

/** Chalk-rendered wordmark for the classic REPL and setup wizard (raw
 * terminal output, not Ink — safe to embed ANSI codes there). */
export function gradientWordmark(text: string = WORDMARK): string {
	return wordmarkChars(text)
		.map(({ ch, color }) => chalk.hex(color).bold(ch))
		.join("");
}

/** "provider · model" badge, chip-styled with the accent as background. */
export function chalkBadge(text: string): string {
	return chalk.bgHex(ACCENT).black.bold(` ${text} `);
}

/** Horizontal rule for the classic REPL banner — box-drawing line on
 * unicode terminals, plain dashes otherwise. */
export function divider(width = 39): string {
	return (supportsUnicode() ? "─" : "-").repeat(width);
}
