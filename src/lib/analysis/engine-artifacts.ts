/**
 * Where the engines' artifacts live.
 *
 * One function, because this has been got wrong twice. Both engines independently
 * wrote `const ARTIFACT_ROOT = "/kuna/"` and `"/rasc/"`, and both were wrong for
 * the same reason: the build sets `base: "./"` so the site can be deployed under
 * a subpath, and a root-absolute path asks a project page for someone else's
 * directory. On `https://<user>.github.io/Repi/` it resolves to
 * `https://<user>.github.io/kuna/`, which is not there, and the engine reports
 * itself as not installed — a broken path that reads as a missing feature.
 *
 * The Kuna copy was fixed and the Rasc copy could not see the fix, because they
 * were written on branches that had not met. So the resolution lives in one place
 * now, and `check:analysis` refuses a driver that reintroduces a root-absolute
 * artifact path.
 *
 * Resolved against the document rather than the module because the artifacts are
 * served as static files from the site root, not bundled next to the JavaScript.
 */
export function artifactUrl(...segments: readonly string[]): string {
  return new URL(segments.join("/"), document.baseURI).href;
}

/** URLs already known to be present. Absence is never cached; see below. */
const present = new Set<string>();

/**
 * Whether an engine's wasm is on the server.
 *
 * Two things have gone wrong here, so both are guarded.
 *
 * `ok` on its own is not enough: a static host with an SPA fallback answers 200
 * with the index page for a path that is not there, so the size is checked too.
 *
 * And a *negative* answer is not cached. The first version cached whatever came
 * back, which meant one dropped request at page load — during a 25 MB site load,
 * or a cold CDN fetch — left that engine reported as "not installed" for the rest
 * of the session. It was intermittent, which is how it survived a check suite that
 * runs against a warm local server. Only a positive answer is a fact worth
 * remembering; a negative one is worth re-asking.
 */
export async function artifactAvailable(
  url: string,
  minimumBytes: number,
  doFetch: typeof fetch = fetch,
): Promise<boolean> {
  if (present.has(url)) return true;

  let ok = false;
  try {
    const response = await doFetch(url, { method: "HEAD" });
    const length = Number(response.headers.get("content-length"));
    ok = response.ok && Number.isFinite(length) && length >= minimumBytes;
  } catch {
    ok = false;
  }

  if (ok) present.add(url);
  return ok;
}
