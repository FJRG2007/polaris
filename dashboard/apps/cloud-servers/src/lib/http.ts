/**
 * One way to call a provider: bounded in time, retried only when the provider
 * asked us to slow down, and parsed against a schema before anything reads it.
 *
 * Every URL is a fixed provider host built in code, never one a person typed, and
 * `fetch` verifies TLS as it always does. A provider's own error text is kept
 * short and is never logged with the request, so a credential in a header can
 * never end up in a log line or on screen.
 *
 * Server-only.
 */

import type { ZodType, ZodTypeDef } from "zod";

/** How long one call may take before it is abandoned. */
export const CALL_TIMEOUT_MS = 20_000;
/** How many times a call is tried when the provider answers 429 or 503. */
const ATTEMPTS = 3;
/** The longest a Retry-After is honoured for; longer is reported, not waited on. */
const MAX_BACKOFF_MS = 10_000;

/** A provider refused or could not be reached. `message` is safe to show. */
export class ProviderError extends Error {
    constructor(
        message: string,
        readonly status: number | null
    ) {
        super(message);
        this.name = "ProviderError";
    }
}

export interface CallInit {
    readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly timeoutMs?: number;
}

/** How long to wait before the next try, from Retry-After or a doubling floor. */
export function backoffMs(retryAfter: string | null, attempt: number): number {
    const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    const asked = Number.isFinite(seconds) ? seconds * 1000 : 1000 * 2 ** attempt;
    return Math.min(Math.max(asked, 250), MAX_BACKOFF_MS);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The response's own error text, trimmed to one short line. */
function shortText(raw: string): string {
    const line = raw.replace(/\s+/g, " ").trim();
    return line.length > 240 ? `${line.slice(0, 240)}...` : line;
}

/** Make the call, retrying on 429/503, and hand back the response that ended it. */
export async function send(url: string, init: CallInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
        let response: Response;
        try {
            response = await fetch(url, {
                method: init.method ?? "GET",
                headers: init.headers,
                body: init.body,
                redirect: "error",
                signal: AbortSignal.timeout(init.timeoutMs ?? CALL_TIMEOUT_MS)
            });
        } catch (caught) {
            const timedOut = caught instanceof Error && caught.name === "TimeoutError";
            throw new ProviderError(
                timedOut ? "The provider did not answer in time." : "The provider could not be reached.",
                null
            );
        }
        if ((response.status === 429 || response.status === 503) && attempt < ATTEMPTS - 1) {
            await response.body?.cancel().catch(() => undefined);
            await sleep(backoffMs(response.headers.get("retry-after"), attempt));
            continue;
        }
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new ProviderError(
                `${response.status}: ${shortText(errorText(text)) || response.statusText}`,
                response.status
            );
        }
        return response;
    }
}

/** The human part of a provider's error body, whichever shape it uses. */
function errorText(body: string): string {
    try {
        const parsed: unknown = JSON.parse(body);
        const found = findMessage(parsed, 0);
        if (found) return found;
    } catch {
        // Not JSON: an XML or text body, shown as it is (trimmed).
    }
    const xml = /<Message>([^<]*)<\/Message>/.exec(body);
    return xml?.[1] ?? body;
}

function findMessage(value: unknown, depth: number): string | null {
    if (depth > 3 || !value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    for (const key of ["message", "error_description", "reason", "detail"]) {
        if (typeof record[key] === "string") return record[key] as string;
    }
    for (const key of ["error", "errors", "messages"]) {
        const inner = record[key];
        if (typeof inner === "string") return inner;
        const nested = findMessage(Array.isArray(inner) ? inner[0] : inner, depth + 1);
        if (nested) return nested;
    }
    return null;
}

/** Call and parse the JSON answer with `schema`. */
export async function callJson<T>(
    schema: ZodType<T, ZodTypeDef, unknown>,
    url: string,
    init: CallInit = {}
): Promise<T> {
    const response = await send(url, init);
    const text = await response.text();
    return parseWith(schema, text ? (JSON.parse(text) as unknown) : {});
}

/** Call when the answer carries nothing to read (204, an accepted action). */
export async function callVoid(url: string, init: CallInit = {}): Promise<Response> {
    const response = await send(url, init);
    await response.body?.cancel().catch(() => undefined);
    return response;
}

/** Validate a provider's answer, reporting a shape we did not expect plainly. */
export function parseWith<T>(schema: ZodType<T, ZodTypeDef, unknown>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ProviderError(
            `The provider answered in a shape Polaris does not read (${issue?.path.join(".") ?? "?"}).`,
            null
        );
    }
    return parsed.data;
}

/** JSON headers with a bearer token. */
export function bearer(token: string): Record<string, string> {
    return {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json"
    };
}
