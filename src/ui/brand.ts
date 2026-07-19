import chalk from "chalk";

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
export const VERSION = "v0.1.0";

export const SPINNER_FRAMES = [
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
