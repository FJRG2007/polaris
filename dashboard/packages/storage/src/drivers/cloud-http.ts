/**
 * What the three consumer-drive drivers share: a bearer request that maps the
 * provider's status onto a StorageError, and the shape of the token supply.
 *
 * The token is a function rather than a value because these connections
 * authorize through somebody's linked account, whose access token expires every
 * hour. A driver built at the top of a large upload would otherwise be signing
 * with a token that has expired by the time the last part goes out. Asking for
 * one per request costs nothing - the app's supplier caches until it is close to
 * expiry - and means a long transfer cannot outlive its own credential.
 */

import { StorageError, type StorageErrorCode } from "../driver.js";

/** Supplies a currently-valid access token for the linked account. */
export type TokenSource = () => Promise<string>;

/** What these drivers ever send as a body. Narrower than the platform's BodyInit,
 *  which is not a global under this package's lib settings. */
export type CloudBody = Uint8Array | string | ReadableStream<Uint8Array> | null;

export interface CloudRequest {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: CloudBody;
    /** Statuses to accept. Anything else is raised. Defaults to 2xx. */
    readonly expect?: readonly number[];
}

/** Send an authorized request and raise anything the caller did not expect. */
export async function cloudFetch(
    token: TokenSource,
    provider: string,
    url: string,
    request: CloudRequest = {}
): Promise<Response> {
    let response: Response;
    try {
        response = await fetch(url, {
            method: request.method ?? "GET",
            headers: { authorization: `Bearer ${await token()}`, ...request.headers },
            body: request.body ?? null
        });
    } catch (error) {
        throw new StorageError("connection_failed", `${provider} is unreachable: ${(error as Error).message}`);
    }
    const ok = request.expect ? request.expect.includes(response.status) : response.ok;
    if (!ok) throw await cloudError(response, provider);
    return response;
}

/** The same, parsed as JSON. */
export async function cloudJson<T>(
    token: TokenSource,
    provider: string,
    url: string,
    request: CloudRequest = {}
): Promise<T> {
    const response = await cloudFetch(token, provider, url, request);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
}

/**
 * Turn a failed response into a StorageError.
 *
 * The provider's own message is kept when there is one: "The user's Drive
 * storage quota has been exceeded" is worth showing, and "Request failed" is
 * not. 429 and 5xx map to io_error rather than a dedicated code because the
 * caller's answer to both is the same - the copy failed, try it again later -
 * and the driver contract has no retryable code to say more.
 */
async function cloudError(response: Response, provider: string): Promise<StorageError> {
    const text = await response.text().catch(() => "");
    let message = text.slice(0, 400);
    try {
        const parsed = JSON.parse(text) as {
            error?: { message?: string; error_summary?: string } | string;
            error_summary?: string;
            message?: string;
        };
        message =
            (typeof parsed.error === "object" ? parsed.error?.message : undefined) ??
            parsed.error_summary ??
            (typeof parsed.error === "string" ? parsed.error : undefined) ??
            parsed.message ??
            message;
    } catch {
        // Not JSON. The truncated body is still the most useful thing to show.
    }
    const code: StorageErrorCode =
        response.status === 404
            ? "not_found"
            : response.status === 401 || response.status === 403
              ? "permission_denied"
              : response.status === 409
                ? "already_exists"
                : "io_error";
    return new StorageError(code, `${provider} ${response.status}: ${message || "request failed"}`);
}

/**
 * Read a whole stream into memory.
 *
 * Only for the small-upload path, where the provider requires a known length and
 * the content is already known to be under a few megabytes. Anything that could
 * be large goes through the chunked/resumable path instead.
 */
export async function collect(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    return new Uint8Array(await new Response(body).arrayBuffer());
}

/**
 * Cut a stream into buffers of exactly `size` bytes, except the last.
 *
 * Every resumable upload API here demands that each chunk but the final one is a
 * multiple of their block size, so the caller needs whole chunks rather than
 * whatever the source happened to emit.
 */
export async function* chunked(stream: ReadableStream<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
    const reader = stream.getReader();
    let held: Uint8Array[] = [];
    let heldBytes = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.byteLength === 0) continue;
            held.push(value);
            heldBytes += value.byteLength;
            while (heldBytes >= size) {
                const joined = join(held, heldBytes);
                yield joined.subarray(0, size);
                const rest = joined.subarray(size);
                held = rest.byteLength > 0 ? [rest] : [];
                heldBytes = rest.byteLength;
            }
        }
        if (heldBytes > 0) yield join(held, heldBytes);
    } finally {
        reader.releaseLock();
    }
}

function join(parts: readonly Uint8Array[], total: number): Uint8Array {
    if (parts.length === 1) return parts[0] as Uint8Array;
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.byteLength;
    }
    return out;
}

/** `bytes=start-end` for a partial read, or undefined when the whole file is wanted. */
export function rangeHeader(range?: { start: number; end?: number }): Record<string, string> | undefined {
    if (!range) return undefined;
    return { range: `bytes=${range.start}-${range.end !== undefined ? range.end : ""}` };
}
