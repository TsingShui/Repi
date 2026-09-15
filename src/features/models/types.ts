import type { PiApiKeyProviderId } from "./pi-providers";

export type ModelProvider = {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly models: readonly string[];
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
