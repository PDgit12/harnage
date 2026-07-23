import { describe, expect, it } from "vitest";
import { isRetryable } from "../src/utils/retry";

describe("isRetryable — retry transient errors, never 4xx client errors", () => {
	it("retries 429 rate limits and 5xx", () => {
		expect(isRetryable(new Error("429 Too Many Requests"))).toBe(true);
		expect(isRetryable(new Error("HTTP 503 service unavailable"))).toBe(true);
		expect(isRetryable({ status: 429, message: "rate limit" })).toBe(true);
	});

	it("retries connection/network hiccups", () => {
		expect(isRetryable(new Error("ECONNRESET"))).toBe(true);
		expect(isRetryable(new Error("request timeout"))).toBe(true);
		expect(isRetryable(new Error("fetch failed"))).toBe(true);
	});

	it("does NOT retry a 413 (retrying the same oversized request just fails again)", () => {
		expect(isRetryable(new Error("413 Request too large for model"))).toBe(
			false,
		);
		expect(isRetryable({ status: 413, message: "payload too large" })).toBe(
			false,
		);
	});

	it("does NOT retry auth failures", () => {
		expect(isRetryable(new Error("401 Unauthorized"))).toBe(false);
		expect(isRetryable(new Error("403 Forbidden"))).toBe(false);
	});

	it("the old wildcard bug: a '5' in a model id or number no longer forces a retry", () => {
		// "gpt-5" / "claude-sonnet-5" / a line number containing 5 used to match
		// msg.includes("5") and trigger pointless retries + backoff.
		expect(isRetryable(new Error("invalid model claude-sonnet-5"))).toBe(false);
		expect(isRetryable(new Error("bad request at line 512"))).toBe(false);
	});
});
