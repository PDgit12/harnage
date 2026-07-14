export interface ContextConfig {
	maxTokens: number; // default 32000 — soft limit
	summaryTokens: number; // default 2000 — reserve for response
	compactionThreshold: number; // default 24000 — trigger compaction when exceeding this
}

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function compactMessages(
	messages: Array<{ role: string; content: string }>,
	config: ContextConfig,
): {
	messages: Array<{ role: string; content: string }>;
	summary: string;
	compactedCount: number;
} {
	const totalTokens = messages.reduce(
		(sum, m) => sum + estimateTokens(m.content),
		0,
	);

	if (totalTokens <= config.compactionThreshold) {
		return { messages, summary: "", compactedCount: 0 };
	}

	const maxTokensPerMessage = config.maxTokens - config.summaryTokens;
	const keepCount = Math.max(
		1,
		Math.floor((maxTokensPerMessage * 0.25) / (totalTokens / messages.length)),
	);

	const toCompact = messages.slice(0, -keepCount);
	const toKeep = messages.slice(-keepCount);

	const summary = toCompact.map((m) => `${m.role}: ${m.content}`).join("\n");

	console.warn(
		`[context] Compacted ${toCompact.length} messages (${totalTokens} tokens → ${estimateTokens(toKeep.map((m) => m.content).join(""))} tokens)`,
	);

	return {
		messages: toKeep,
		summary,
		compactedCount: toCompact.length,
	};
}
