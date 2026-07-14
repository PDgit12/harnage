import type { ProviderConfig } from "../api/client";

const OLLAMA_BASE = "http://localhost:11434";

export interface OllamaHealth {
	running: boolean;
	models: string[];
	responseTimeMs: number;
	error?: string;
}

interface OllamaTagsResult {
	ok: boolean;
	models: Array<{ name: string }>;
	responseTimeMs: number;
	error?: string;
}

async function fetchOllamaTags(
	signal?: AbortSignal,
): Promise<OllamaTagsResult> {
	const start = performance.now();
	try {
		const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
			signal: signal ?? AbortSignal.timeout(5000),
		});
		const elapsed = Math.round(performance.now() - start);
		if (!res.ok)
			return {
				ok: false,
				models: [],
				responseTimeMs: elapsed,
				error: res.statusText,
			};
		const data = (await res.json()) as { models?: Array<{ name: string }> };
		return { ok: true, models: data.models ?? [], responseTimeMs: elapsed };
	} catch (e) {
		const elapsed = Math.round(performance.now() - start);
		return {
			ok: false,
			models: [],
			responseTimeMs: elapsed,
			error: e instanceof Error ? e.message : String(e),
		};
	}
}

export async function checkOllamaRunning(): Promise<boolean> {
	const r = await fetchOllamaTags(AbortSignal.timeout(2000));
	return r.ok;
}

export async function listOllamaModels(): Promise<string[]> {
	const r = await fetchOllamaTags();
	return r.models.map((m) => m.name);
}

export async function detectOllamaConfig(): Promise<ProviderConfig | null> {
	const r = await fetchOllamaTags();
	if (!r.ok || r.models.length === 0) return null;
	return {
		type: "ollama",
		model: r.models[0]?.name,
		baseUrl: OLLAMA_BASE,
		maxTokens: 4096,
	};
}

export async function checkOllamaHealth(): Promise<OllamaHealth> {
	const r = await fetchOllamaTags();
	return {
		running: r.ok,
		models: r.models.map((m) => m.name),
		responseTimeMs: r.responseTimeMs,
		error: r.error,
	};
}

export async function pullOllamaModel(
	name: string,
): Promise<ReadableStream<Uint8Array> | null> {
	try {
		const res = await fetch(`${OLLAMA_BASE}/api/pull`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name, stream: true }),
		});
		if (!res.ok || !res.body) return null;
		return res.body;
	} catch {
		return null;
	}
}
