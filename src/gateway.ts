import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createModels, createProvider, type Models, type Provider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";

/**
 * Model calls through a gateway instead of straight to the provider: Bifrost, LiteLLM, Cloudflare AI Gateway, or
 * spoond's (OpenAI-compatible only). The gateway holds the provider keys, enforces budgets, fails over and caches;
 * Scout holds one gateway key. Provider and model names stay the same (`anthropic/claude-…`), so nothing else changes.
 */
export type GatewayConfig = {
	/** Base URL the provider's API is served under, e.g. `https://bifrost.lan/anthropic` or `…/openai/v1`. */
	url: string;
	/** The gateway's key, sent the way the provider's own key would be. */
	key?: string;
	/** Extra headers on every request, e.g. a virtual key or a team for spend attribution. */
	headers?: Record<string, string>;
	/** How to speak OpenAI through it: `responses` (OpenAI's own API) or `completions` (what most gateways serve). */
	openaiApi?: "responses" | "completions";
};

/** Model access: the providers Scout knows, direct or through a gateway. */
export function modelsFor(gateway?: GatewayConfig): Models {
	const models = createModels();
	if (gateway === undefined) {
		models.setProvider(anthropicProvider());
		models.setProvider(openaiProvider());
		return models;
	}
	for (const provider of gatewayProviders(gateway)) models.setProvider(provider);
	return models;
}

export function gatewayProviders(gateway: GatewayConfig): Provider[] {
	const auth = {
		apiKey: {
			name: "gateway key",
			resolve: async () => (gateway.key === undefined ? { auth: {}, source: "gateway" } : { auth: { apiKey: gateway.key }, source: "SCOUT_GATEWAY_KEY" }),
		},
	};
	const headers = gateway.headers ?? {};
	return [
		createProvider({
			id: "anthropic",
			name: "Anthropic via gateway",
			baseUrl: gateway.url,
			headers,
			auth,
			// Each catalog model names its own base URL and headers; point every one at the gateway.
			models: Object.values(ANTHROPIC_MODELS).map((m) => ({ ...m, baseUrl: gateway.url, headers: { ...m.headers, ...headers } })),
			api: anthropicMessagesApi(),
		}) as Provider,
		createProvider({
			id: "openai",
			name: "OpenAI via gateway",
			baseUrl: gateway.url,
			headers,
			auth,
			models: Object.values(OPENAI_MODELS).map((m) => ({ ...m, baseUrl: gateway.url, headers: { ...m.headers, ...headers } })),
			api: gateway.openaiApi === "responses" ? openAIResponsesApi() : openAICompletionsApi(),
		}) as Provider,
	];
}
