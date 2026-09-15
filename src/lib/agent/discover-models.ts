const MAX_CATALOG_BYTES = 5 * 1024 * 1024;
const MAX_MODELS = 5_000;

function catalogUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/models") ? path : `${path}/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function modelId(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const candidate = record.id ?? record.model ?? record.name;
  return typeof candidate === "string" ? candidate.trim() || null : null;
}

/**
 * Whether a catalog entry says its model can think.
 *
 * Nothing requires an OpenAI-compatible endpoint to describe its models, and most say nothing at
 * all — in which case this is false and the model is treated as one that answers directly. Where
 * a catalog *does* describe reasoning (OpenRouter and gateways that copy it carry
 * `supported_parameters`, some carry a plain flag), reading it is better than asking the user to
 * retype what the endpoint already told us. Only the fields listed here are read: a wrong guess
 * would be sent as a `reasoning_effort` the endpoint never agreed to accept.
 */
function advertisesReasoning(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;

  const parameters = record.supported_parameters ?? record.supportedParameters;
  if (Array.isArray(parameters)) {
    if (parameters.some((value) => value === "reasoning" || value === "include_reasoning")) {
      return true;
    }
  }

  if (record.reasoning === true) return true;

  const capabilities = record.capabilities;
  if (capabilities && typeof capabilities === "object") {
    const reasoning = (capabilities as Record<string, unknown>).reasoning;
    if (reasoning === true) return true;
    if (reasoning && typeof reasoning === "object") {
      if ((reasoning as Record<string, unknown>).supported === true) return true;
    }
  }

  for (const key of ["features", "tags"]) {
    const list = record[key];
    if (Array.isArray(list) && list.some((value) => value === "reasoning" || value === "thinking")) {
      return true;
    }
  }

  return false;
}

/** One model as the catalog described it. */
export interface DiscoveredModel {
  readonly id: string;
  /** The catalog claimed the model accepts a reasoning effort. */
  readonly reasoning: boolean;
}

function catalogEntries(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.data)) return record.data;
  if (Array.isArray(record.models)) return record.models;
  if (Array.isArray(record.result)) return record.result;
  return [];
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return response.statusText;
  try {
    const payload = JSON.parse(text) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    if (typeof payload.error === "string") return payload.error;
    if (typeof payload.error?.message === "string") return payload.error.message;
    if (typeof payload.message === "string") return payload.message;
  } catch {
    // A short non-JSON response is still useful provider feedback.
  }
  return text.slice(0, 300);
}

/**
 * Provider-owned model discovery, following Pi's dynamic catalog seam for a
 * generic OpenAI-compatible endpoint.
 */
export async function discoverOpenAIModels(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<readonly DiscoveredModel[]> {
  let endpoint: string;
  try {
    endpoint = catalogUrl(baseUrl.trim());
  } catch {
    throw new Error("Enter a valid provider Base URL before discovering models.");
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      credentials: "omit",
      ...(signal ? { signal } : {}),
      headers: {
        Accept: "application/json",
        ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}),
      },
    });
  } catch (error) {
    if (signal?.aborted) throw new Error("Model discovery was cancelled.");
    throw new Error(
      "Could not reach the model catalog. Check the Base URL and browser CORS settings.",
      { cause: error },
    );
  }

  if (!response.ok) {
    const detail = await errorDetail(response);
    throw new Error(`Model discovery failed (${response.status})${detail ? `: ${detail}` : "."}`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CATALOG_BYTES) {
    throw new Error("The provider's model catalog is unexpectedly large.");
  }

  const text = await response.text();
  if (text.length > MAX_CATALOG_BYTES) {
    throw new Error("The provider's model catalog is unexpectedly large.");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("The provider returned a model catalog that is not valid JSON.");
  }

  // One entry per id, and a claim of reasoning anywhere among an id's duplicates counts: the
  // same model listed twice with the flag on one of them is a model that can think.
  const models = new Map<string, DiscoveredModel>();
  for (const entry of catalogEntries(payload).slice(0, MAX_MODELS)) {
    const id = modelId(entry);
    if (id === null) continue;
    const reasoning = advertisesReasoning(entry);
    const known = models.get(id);
    models.set(id, { id, reasoning: reasoning || known?.reasoning === true });
  }
  if (models.size === 0) {
    throw new Error("The provider returned no model IDs. You can enter them manually instead.");
  }
  return [...models.values()];
}
