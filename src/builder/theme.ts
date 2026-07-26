// Per-harness theming: every generated harness keeps the SAME layout/chassis
// but gets an accent palette derived from what it's actually for — a finance
// agent reads green, a security agent red, a creative agent purple, etc. Only
// the accent (banner wordmark gradient, prompt glyph, highlights) changes; the
// structure is identical. Terminal truecolor hex, with a darker "dim" variant
// for the gradient wordmark's tail.

export interface Theme {
	accent: string;
	accentDim: string;
}

// Keyword → palette. First match wins, so order most-specific first. Each entry
// is [accent, accentDim] where accentDim is a darker shade of the same hue.
const DOMAIN_THEMES: Array<{ re: RegExp; theme: Theme }> = [
	{
		re: /\b(security|vuln|threat|pentest|exploit|malware|auth|cve|forensic)/,
		theme: { accent: "#ef4444", accentDim: "#991b1b" }, // red
	},
	{
		re: /\b(finance|money|trading|invoice|payment|revenue|sales|gtm|pricing|budget|accounting|crypto)/,
		theme: { accent: "#22c55e", accentDim: "#15803d" }, // green
	},
	{
		re: /\b(data|csv|sql|etl|dataset|analytics|dedup|rows|warehouse|pipeline)/,
		theme: { accent: "#3b82f6", accentDim: "#1d4ed8" }, // blue
	},
	{
		re: /\b(design|creative|art|image|story|content|marketing|brand|copy|social)/,
		theme: { accent: "#a855f7", accentDim: "#7e22ce" }, // purple
	},
	{
		re: /\b(devops|deploy|infra|ci\/cd|\bci\b|docker|kubernetes|k8s|terraform|pipeline|release)/,
		theme: { accent: "#f97316", accentDim: "#c2410c" }, // orange
	},
	{
		re: /\b(doc|docs|markdown|readme|wiki|blog|write-?up|summar|changelog)/,
		theme: { accent: "#f59e0b", accentDim: "#b45309" }, // amber
	},
	{
		re: /\b(support|customer|ticket|helpdesk|triage|chat|inbox)/,
		theme: { accent: "#0ea5e9", accentDim: "#0369a1" }, // sky
	},
	{
		re: /\b(legal|contract|compliance|policy|gdpr|regulat|clause)/,
		theme: { accent: "#6366f1", accentDim: "#4338ca" }, // indigo
	},
	{
		re: /\b(health|medical|clinical|fitness|patient|diagnos|wellness)/,
		theme: { accent: "#14b8a6", accentDim: "#0f766e" }, // teal
	},
	{
		re: /\b(review|\bpr\b|diff|lint|refactor|code|program|repo|codebase|compile)/,
		theme: { accent: "#22d3ee", accentDim: "#0e7490" }, // cyan (coding)
	},
];

// Varied fallback palette so even an unmatched domain isn't always the same
// default — picked deterministically from the text so a given harness always
// themes the same way across rebuilds.
const FALLBACK_PALETTE: Theme[] = [
	{ accent: "#22d3ee", accentDim: "#0e7490" }, // cyan
	{ accent: "#818cf8", accentDim: "#4f46e5" }, // indigo-light
	{ accent: "#f472b6", accentDim: "#be185d" }, // pink
	{ accent: "#34d399", accentDim: "#059669" }, // emerald
	{ accent: "#fbbf24", accentDim: "#d97706" }, // gold
];

function hashString(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
	return h;
}

/** Pick an accent palette for a harness from its description + name. */
export function pickTheme(text: string): Theme {
	const t = text.toLowerCase();
	for (const { re, theme } of DOMAIN_THEMES) {
		if (re.test(t)) return theme;
	}
	return FALLBACK_PALETTE[hashString(t) % FALLBACK_PALETTE.length];
}
