import { log } from "./cli.ts";
import { apiUrlFor } from "./apiUrl.ts";

type ApiFetchOptions = {
  path: string;
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  signal?: AbortSignal | undefined;
};

/** Request against the Polaris instance that dispatched this run. */
export async function apiFetch(options: ApiFetchOptions): Promise<Response> {
  const url = apiUrlFor(options.path);
  const headers: Record<string, string> = { ...options.headers };

  // A body-less request has no defined Content-Type semantics (RFC 9110 8.3) and
  // some hosts answer 500 rather than ignoring it, so never send one.
  if (!options.body) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "content-type") delete headers[key];
    }
  }

  log.debug(`api fetch: ${options.method ?? "GET"} ${url.pathname}`);

  const init: RequestInit = { method: options.method ?? "GET", headers };
  if (options.body) init.body = options.body;
  if (options.signal) init.signal = options.signal;

  return fetch(url.toString(), init);
}
