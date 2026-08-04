/**
 * Control-plane fetch for entryPost.ts.
 *
 * Deliberately stdlib-only, enforced by entryPost.stdlibOnly.test.ts: the post
 * step has to run after a cancellation or a timeout, when the main step may have
 * left the process in any state, so it imports nothing that could fail to load.
 * That is why the origin resolution and path re-rooting below are duplicated
 * from ./apiUrl.ts rather than imported.
 */

type PostApiFetchOptions = {
  path: string;
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
};

const API_ROOT = "/api/agents";

function apiUrlFor(path: string): URL {
  const raw = process.env.POLARIS_API_URL;
  if (!raw) throw new Error("POLARIS_API_URL is not set");
  const base = raw.replace(/\/+$/, "");
  const rooted = path.startsWith("/api/") ? `${API_ROOT}${path.slice(4)}` : path;
  return new URL(`${base}${rooted.startsWith("/") ? "" : "/"}${rooted}`);
}

export async function postApiFetch(options: PostApiFetchOptions): Promise<Response> {
  const url = apiUrlFor(options.path);
  const headers: Record<string, string> = { ...options.headers };

  if (!options.body) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "content-type") delete headers[key];
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers,
      signal: controller.signal,
    };
    if (options.body) init.body = options.body;

    return await fetch(url, init);
  } finally {
    clearTimeout(timeoutId);
  }
}
