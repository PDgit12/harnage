import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "../src/services/api/client";
import {
	isSharedProxyConfig,
	pickSharedProxyModel,
	SHARED_PROXY_MODELS,
} from "../src/services/api/resolve";

const proxyConfig: ProviderConfig = {
	type: "openai",
	model: "auto/cheap",
	apiKey: "harnage-shared-build-brain",
	baseUrl: "https://proxy.example.com",
	maxTokens: 8192,
};

describe("isSharedProxyConfig", () => {
	it("recognizes the shared proxy placeholder key", () => {
		expect(isSharedProxyConfig(proxyConfig)).toBe(true);
	});

	it("does not flag a real provider config", () => {
		expect(
			isSharedProxyConfig({
				type: "openai",
				model: "gpt-4o",
				apiKey: "sk-real-key",
				maxTokens: 8192,
			}),
		).toBe(false);
	});
});

describe("pickSharedProxyModel", () => {
	it("no-ops when ask is absent (non-interactive path never blocks)", async () => {
		const result = await pickSharedProxyModel(proxyConfig);
		expect(result).toBe(proxyConfig);
	});

	it("no-ops for non-proxy configs even with ask present", async () => {
		const real: ProviderConfig = {
			type: "anthropic",
			model: "claude-sonnet-5",
			apiKey: "sk-real",
			maxTokens: 8192,
		};
		const result = await pickSharedProxyModel(real, async (_q, d) => d);
		expect(result).toBe(real);
	});

	it("only offers OmniRoute's allowed routing strings", () => {
		expect(SHARED_PROXY_MODELS.map((m) => m.id)).toEqual(["auto/cheap", "auto"]);
	});

	it("applies the picked model by number", async () => {
		const result = await pickSharedProxyModel(proxyConfig, async () => "2");
		expect(result.model).toBe("auto");
	});

	it("applies the picked model by id", async () => {
		const result = await pickSharedProxyModel(proxyConfig, async () => "auto");
		expect(result.model).toBe("auto");
	});

	it("falls back to the default on garbage input", async () => {
		const result = await pickSharedProxyModel(proxyConfig, async () => "nope");
		expect(result.model).toBe("auto/cheap");
	});
});
