/**
 * What is known about a model: how much it can think, and how much it can hold.
 *
 * Both answers come from the same object and the same source — pi's catalog for a built-in
 * provider, and for a custom endpoint the one model object this app builds because pi cannot
 * know it. Keeping them together is what stops the app from having two opinions about a model:
 * a menu that offers a level and then a request that sends another, or a window displayed as one
 * number and enforced as another.
 *
 * A level is not a property of the app and not a property of the model id as a string: it is a
 * property of *this* model on *this* endpoint. pi already owns that question —
 * `getSupportedThinkingLevels` reads a model's `reasoning` flag and its `thinkingLevelMap`, and
 * `clampThinkingLevel` folds a request into what the model accepts — so this file does not
 * answer it twice. It builds the one thing pi cannot know about (a custom provider's model) and
 * hands both questions to pi.
 *
 * That arrangement is the point: the menu the user picks from and the level that goes out on
 * the wire are derived from the same model object, so they cannot disagree.
 */
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { loadPiProvider } from "./pi-providers";
import type { ModelProvider } from "./types";

/** pi's levels, in the order they cost money. */
export const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Whether this provider's catalog entry claims the model can think. */
export function declaresReasoning(provider: ModelProvider, modelId: string): boolean {
  return provider.reasoningModels?.includes(modelId) === true;
}

/**
 * A custom provider's model, as pi sees it.
 *
 * A generic OpenAI-compatible endpoint says nothing about its models, so the model object is
 * built from the few things the user configured. `reasoning` is the one field with teeth: with
 * it, pi sends `reasoning_effort`; without it, a level is clamped to "off" rather than sent as
 * a field the endpoint never agreed to understand.
 */
/**
 * What a custom provider's model is assumed to hold.
 *
 * `maxTokens` is not inert: it goes out on every request as `max_completion_tokens`, so a model
 * whose real ceiling is lower is rejected by its own endpoint. The window is metadata for now —
 * nothing in the agent reads it — which is exactly why it is worth showing rather than trusting.
 */
const ASSUMED_LIMITS: ModelLimits = {
  contextWindow: 128_000,
  maxTokens: 16_384,
  assumed: true,
};

export function customModel(
  provider: ModelProvider,
  modelId: string,
): Model<"openai-completions"> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: provider.id,
    baseUrl: provider.baseUrl,
    reasoning: declaresReasoning(provider, modelId),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: ASSUMED_LIMITS.contextWindow,
    maxTokens: ASSUMED_LIMITS.maxTokens,
  };
}

/**
 * The model object behind a selection: pi's, or one built from the provider's own words.
 *
 * A built-in model is looked up in pi's catalog, which is where its `thinkingLevelMap` lives —
 * the map that says which levels this model names differently, and which ones it does not have.
 */
async function modelFor(
  provider: ModelProvider,
  modelId: string,
): Promise<Model<string> | null> {
  if (provider.kind === "custom") return customModel(provider, modelId);
  const pi = await loadPiProvider(provider.builtinId);
  return pi.getModels().find((candidate) => candidate.id === modelId) ?? null;
}

/** What the control needs to show: the menu, and where the current request lands in it. */
export interface ThinkingOptions {
  readonly levels: readonly ModelThinkingLevel[];
  /** The requested level clamped to `levels` — what the user is actually going to get. */
  readonly effective: ModelThinkingLevel;
}

/**
 * The levels this selection accepts, and where the conversation's request falls.
 *
 * Both answers come from one model object and pi's own two functions, so the value shown in the
 * control is the value the request will carry — the alternative is a menu that quietly disagrees
 * with the request, which is worse than not offering the menu.
 *
 * A model that is not in the catalog — removed upstream, or a provider that changed its list —
 * reports "off" rather than an error: the level is not the thing that went missing.
 */
export async function thinkingOptions(
  provider: ModelProvider,
  modelId: string,
  requested: ModelThinkingLevel | undefined,
): Promise<ThinkingOptions> {
  const model = await modelFor(provider, modelId);
  if (model === null) return { levels: ["off"], effective: "off" };
  return {
    levels: getSupportedThinkingLevels(model),
    effective: resolveThinkingLevel(model, requested),
  };
}

/** The requested level, folded into what this model actually accepts. */
export function resolveThinkingLevel(
  model: Model<string>,
  requested: ModelThinkingLevel | undefined,
): ModelThinkingLevel {
  return clampThinkingLevel(model, requested ?? "off");
}

/**
 * What a model can hold, and whether this app knows that or is guessing.
 *
 * `assumed` is not decoration. A built-in model's window comes from pi's catalog; a custom
 * endpoint's comes from a constant in this file, because an OpenAI-compatible endpoint does not
 * have to describe its models — and a number that was guessed should not be displayed like one
 * that was read.
 */
export interface ModelLimits {
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly assumed: boolean;
}

export async function modelLimits(provider: ModelProvider, modelId: string): Promise<ModelLimits> {
  const model = await modelFor(provider, modelId);
  if (model === null) return ASSUMED_LIMITS;
  return {
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    assumed: provider.kind === "custom",
  };
}

/** A model object for the agent loop, built the same way the menu was. */
export { modelFor };
