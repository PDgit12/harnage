/**
 * A transient error worth retrying with backoff: rate limits (429), server
 * errors (5xx), and connection/network hiccups. Deliberately NOT retryable:
 * 4xx client errors like 413 (payload too large — retrying the same oversized
 * request just fails again) and 401/403 (auth). The old check used
 * `msg.includes("5")`, a bare-digit substring that matched any error text
 * containing a "5" (a model id like gpt-5, a line number, a byte count) —
 * retrying non-retryable failures AND missing 413 entirely.
 */
export function isRetryable(err: unknown): boolean {
	const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
	const status =
		typeof err === "object" && err !== null && "status" in err
			? Number((err as { status?: unknown }).status)
			: Number.NaN;
	if (status === 429 || (status >= 500 && status < 600)) return true;
	if (status >= 400 && status < 500) return false; // 413/401/403 etc. — don't retry
	// Message-only fallback: match specific common HTTP statuses, not a broad
	// `5\d\d` — that matched any 3-digit number (a line number like 512, a byte
	// count) and forced pointless retries.
	return (
		/\b(429|500|502|503|504)\b/.test(msg) ||
		msg.includes("rate limit") ||
		msg.includes("econn") ||
		msg.includes("timeout") ||
		msg.includes("network") ||
		msg.includes("socket") ||
		(msg.includes("fetch") && msg.includes("failed"))
	);
}

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
			if (isRetryable(err)) {
				const delay = baseDelayMs * 2 ** (attempt - 1) + Math.random() * 100;
				await new Promise((r) => setTimeout(r, delay));
			} else {
				throw err;
			}
		}
	}
	throw new Error("unreachable");
}
