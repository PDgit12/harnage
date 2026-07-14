import type { Provider } from "./client";

export interface CompleteResult {
	text: string;
	usage?: { promptTokens: number; completionTokens: number };
}

/**
 * One-shot completion over a streaming Provider. Collects text events into a
 * single string. Error events become thrown errors — providers yield errors
 * as events rather than throwing, so without this the failure mode would be
 * a silently empty completion.
 */
export async function completeText(
	provider: Provider,
	messages: Array<{ role: string; content: string }>,
): Promise<CompleteResult> {
	let text = "";
	let usage: CompleteResult["usage"];

	for await (const event of provider.stream(messages)) {
		if (event.type === "text" && event.content) {
			text += event.content;
		} else if (event.type === "error") {
			throw new Error(event.content ?? "Provider stream error");
		} else if (event.type === "done" && event.usage) {
			usage = event.usage;
		}
	}

	if (text.trim().length === 0) {
		throw new Error("Provider returned empty completion");
	}
	return { text, usage };
}
