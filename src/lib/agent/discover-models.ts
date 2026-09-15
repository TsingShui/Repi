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
): Promise<readonly string[]> {
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

  const models = [
    ...new Set(
      catalogEntries(payload)
        .slice(0, MAX_MODELS)
        .map(modelId)
        .filter((id): id is string => id !== null),
    ),
  ];
  if (models.length === 0) {
    throw new Error("The provider returned no model IDs. You can enter them manually instead.");
  }
  return models;
}
