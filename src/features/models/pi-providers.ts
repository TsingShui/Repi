import type { Provider } from "@earendil-works/pi-ai";

export type PiApiKeyProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "deepseek"
  | "xai"
  | "openrouter"
  | "groq"
  | "mistral"
  | "cerebras"
  | "fireworks"
  | "together"
  | "nvidia";

export interface PiProviderChoice {
  readonly id: PiApiKeyProviderId;
  readonly name: string;
  readonly description: string;
}

export const PI_API_KEY_PROVIDERS: readonly PiProviderChoice[] = [
  { id: "openai", name: "OpenAI", description: "OpenAI Responses API" },
  { id: "anthropic", name: "Anthropic", description: "Claude API" },
  { id: "google", name: "Google Gemini", description: "Google AI Studio" },
  { id: "deepseek", name: "DeepSeek", description: "DeepSeek API" },
  { id: "xai", name: "xAI", description: "Grok API" },
  { id: "openrouter", name: "OpenRouter", description: "OpenRouter API credits" },
  { id: "groq", name: "Groq", description: "GroqCloud API" },
  { id: "mistral", name: "Mistral", description: "Mistral API" },
  { id: "cerebras", name: "Cerebras", description: "Cerebras Inference" },
  { id: "fireworks", name: "Fireworks", description: "Fireworks AI" },
  { id: "together", name: "Together AI", description: "Together inference" },
  { id: "nvidia", name: "NVIDIA NIM", description: "NVIDIA API catalog" },
];

export async function loadPiProvider(id: PiApiKeyProviderId): Promise<Provider> {
  switch (id) {
    case "openai":
      return (await import("@earendil-works/pi-ai/providers/openai")).openaiProvider();
    case "anthropic":
      return (await import("@earendil-works/pi-ai/providers/anthropic")).anthropicProvider();
    case "google":
      return (await import("@earendil-works/pi-ai/providers/google")).googleProvider();
    case "deepseek":
      return (await import("@earendil-works/pi-ai/providers/deepseek")).deepseekProvider();
    case "xai":
      return (await import("@earendil-works/pi-ai/providers/xai")).xaiProvider();
    case "openrouter":
      return (await import("@earendil-works/pi-ai/providers/openrouter")).openrouterProvider();
    case "groq":
      return (await import("@earendil-works/pi-ai/providers/groq")).groqProvider();
    case "mistral":
      return (await import("@earendil-works/pi-ai/providers/mistral")).mistralProvider();
    case "cerebras":
      return (await import("@earendil-works/pi-ai/providers/cerebras")).cerebrasProvider();
    case "fireworks":
      return (await import("@earendil-works/pi-ai/providers/fireworks")).fireworksProvider();
    case "together":
      return (await import("@earendil-works/pi-ai/providers/together")).togetherProvider();
    case "nvidia":
      return (await import("@earendil-works/pi-ai/providers/nvidia")).nvidiaProvider();
  }
}

export async function piApiKeySetup(id: PiApiKeyProviderId): Promise<{
  readonly name: string;
  readonly baseUrl: string;
  readonly models: readonly string[];
}> {
  const provider = await loadPiProvider(id);
  const models = provider.getModels().map((model) => model.id);
  if (models.length === 0) throw new Error(`${provider.name} has no models in this Pi catalog.`);
  return { name: provider.name, baseUrl: provider.baseUrl ?? "", models };
}
