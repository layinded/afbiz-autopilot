/**
 * LLM wiring - any OpenAI-compatible endpoint (proven pattern from the
 * reference repos' model factory). An unauthenticated endpoint still constructs
 * (boot must succeed with placeholder env); the first inference will fail 401
 * loudly, which is logged, never masked.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { AppConfig } from "../lib/config.js";

export interface ModelInfo {
  provider: string;
  modelName: string;
  endpointHost: string;
  authenticated: boolean;
}

export function createChatModel(config: AppConfig): { model: LanguageModel; info: ModelInfo } {
  const provider = createOpenAICompatible({
    name: "afbiz-openai-compat",
    baseURL: config.modelBaseUrl,
    apiKey: config.modelApiKey,
  });
  return {
    model: provider.chatModel(config.modelName),
    info: {
      provider: config.modelProvider === "ollama" ? "ollama" : "openai-compatible",
      modelName: config.modelName,
      endpointHost: new URL(config.modelBaseUrl).host,
      authenticated: Boolean(config.modelApiKey),
    },
  };
}
