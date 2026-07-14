export async function withRetry<T>(
	fn: () => T | Promise<T>,
	options?: { maxAttempts?: number; baseDelayMs?: number },
): Promise<T> {
	const maxAttempts = options?.maxAttempts ?? 3;
	const baseDelayMs = options?.baseDelayMs ?? 1000;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			if (attempt === maxAttempts) throw err;
			const msg = err instanceof Error ? err.message : String(err);
			if (
				msg.includes("429") ||
				msg.includes("5") ||
				msg.includes("ECONN") ||
				msg.includes("TIMEOUT") ||
				msg.includes("network") ||
				msg.includes("fetch")
			) {
				const delay = baseDelayMs * 2 ** (attempt - 1) + Math.random() * 100;
				await new Promise((r) => setTimeout(r, delay));
			} else {
				throw err;
			}
		}
	}
	throw new Error("unreachable");
}
