import type { PiApiKeyProviderId } from "./pi-providers";

export type ModelProvider = {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly models: readonly string[];
  /**
   * The models on this provider that accept a reasoning effort, by id.
   *
   * Only a custom provider needs this: a built-in one carries pi's own catalog, which knows
   * each model's capabilities. An arbitrary OpenAI-compatible endpoint does not have to say
   * anything about a model, and a wrong guess here is paid for on every request — a
   * `reasoning_effort` an endpoint does not understand is an error, not a hint it ignores.
   */
  readonly reasoningModels?: readonly string[];
  readonly createdAt: number;
} & (
  | {
      readonly kind: "custom";
      readonly apiKey: string;
    }
  | {
      readonly kind: "api-key";
      readonly builtinId: PiApiKeyProviderId;
      readonly apiKey: string;
    }
);

export type NewModelProvider = ModelProvider extends infer T
  ? T extends ModelProvider
    ? Omit<T, "id" | "createdAt">
    : never
  : never;

export function modelKey(providerId: string, model: string): string {
  return `${providerId}:${model}`;
}
