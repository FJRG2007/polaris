/**
 * Talking to a Polaris: one request, one schema, one sentence when it fails.
 *
 * The token travels in the Authorization header and nowhere else - never in a
 * URL, never in a message. Certificates are verified (Node's default); a
 * Polaris on a private CA is trusted by pointing `NODE_EXTRA_CA_CERTS` at it,
 * which is said in the error rather than offered as a switch that turns
 * verification off.
 */

import type { z } from "zod";
import { CliError } from "./errors.js";
import { userAgent } from "./version.js";
import { refusalSchema } from "./schemas.js";
import { performance } from "node:perf_hooks";
import { mark, timing } from "./timing.js";
import { PROTOCOL_HEADER, compatibilityProblem } from "./compat.js";

export interface Connection {
    /** The Polaris address, without a trailing slash. */
    readonly url: string;
    /** Null for the requests that come before signing in. */
    readonly token: string | null;
}

export type Fetch = typeof fetch;

export interface CallOptions {
    readonly body?: unknown;
    readonly fetch?: Fetch;
    readonly timeoutMs?: number;
}

/** Why a request never got an answer, in words, from the error Node threw. */
export function unreachableReason(caught: unknown): string {
    const cause = (caught as { cause?: { code?: string } } | null)?.cause;
    const code = cause?.code ?? (caught as { code?: string } | null)?.code ?? "";
    const name = (caught as { name?: string } | null)?.name ?? "";
    if (
        name === "TimeoutError" ||
        name === "AbortError" ||
        code === "ETIMEDOUT" ||
        code === "UND_ERR_CONNECT_TIMEOUT"
    ) {
        return "it did not answer in time";
    }
    if (code === "ECONNREFUSED") return "nothing is answering at that address";
    // The fetch standard's blocked ports (1, 21, 25...), refused before any
    // connection is tried. Only a mistyped port lands here.
    if ((cause as { message?: string } | undefined)?.message === "bad port") {
        return "that port is one Node refuses to connect to; use the port Polaris answers on";
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN")
        return "that name does not resolve from this computer";
    if (code === "ECONNRESET") return "the connection was cut off";
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) {
        return "its certificate is not trusted by this computer (for a private CA, set NODE_EXTRA_CA_CERTS to its certificate file)";
    }
    return "the connection failed";
}

/** The refusal a response carries, or null. */
async function refusalOf(
    response: Response
): Promise<{ error: string; requiredScope?: string } | null> {
    const parsed = refusalSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? parsed.data : null;
}

/** A refusal, as something to do about it. */
export function refusalMessage(
    url: string,
    status: number,
    refusal: { error: string; requiredScope?: string } | null
): string {
    if (status === 401) {
        // Said the same way whichever it was: signed out from Sessions or API
        // keys, locked to an address it was used away from, or simply expired.
        // The server does not say which, and the answer is the same.
        return `You were signed out from Polaris at ${url} (the sign-in was ended there, or it expired). Run plr login to sign in again.`;
    }
    if (status === 403) {
        const needs = refusal?.requiredScope
            ? ` (it needs the ${refusal.requiredScope} permission)`
            : "";
        return `This sign-in is not allowed to do that${needs}. Your account may not have access; ask an administrator, then run plr login again.`;
    }
    if (refusal?.error) return refusal.error;
    if (status === 404)
        return "Polaris does not have that. Check the name; plr projects lists what you can reach.";
    if (status >= 500) return `Polaris could not answer (HTTP ${status}). Try again in a moment.`;
    return `Polaris refused the request (HTTP ${status}).`;
}

/** A redirect, as the address to sign in to instead. */
export function redirectMessage(url: string, response: Response): string {
    const location = response.headers.get("location");
    let origin: string | null = null;
    try {
        origin = location ? new URL(location, url).origin : null;
    } catch {
        origin = null;
    }
    return origin && origin !== url
        ? `${url} sends requests on to ${origin}. Sign in with that address: plr login --url ${origin}`
        : `${url} answered with a redirect this CLI does not follow. Check the address.`;
}

/** The headers every request carries. */
function headers(connection: Connection, json: boolean): Record<string, string> {
    return {
        "user-agent": userAgent(),
        accept: "application/json",
        ...(json ? { "content-type": "application/json" } : {}),
        ...(connection.token ? { authorization: `Bearer ${connection.token}` } : {})
    };
}

/** Send a request and get the raw response, or a CliError that says why there
 *  was none. */
export async function send(
    connection: Connection,
    method: string,
    path: string,
    options: CallOptions = {}
): Promise<Response> {
    const doFetch = options.fetch ?? fetch;
    const startedAt = timing() ? performance.now() : 0;
    // Named without its query, which can carry a service's name.
    const label = `${method} ${path.split("?")[0]}`;
    try {
        const response = await doFetch(`${connection.url}${path}`, {
            method,
            headers: headers(connection, options.body !== undefined),
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            // Not followed: a redirect would carry the token to wherever it
            // points. The address it names is reported instead, to sign in with.
            redirect: "manual",
            signal: AbortSignal.timeout(options.timeoutMs ?? 30_000)
        });
        mark(`${label} ${response.status}`, startedAt);
        return response;
    } catch (caught) {
        mark(`${label} failed`, startedAt);
        throw new CliError(`Could not reach ${connection.url}: ${unreachableReason(caught)}.`);
    }
}

/**
 * One call: send it, refuse anything that is not a 2xx in words, and parse the
 * answer through `schema`.
 */
export async function call<Schema extends z.ZodTypeAny>(
    connection: Connection,
    method: string,
    path: string,
    schema: Schema,
    options: CallOptions = {}
): Promise<z.infer<Schema>> {
    const response = await send(connection, method, path, options);
    // First: a server on a different API can answer anything at all, and the
    // only useful thing to say then is how to get the two back in step.
    const mismatch = compatibilityProblem(connection.url, response.headers.get(PROTOCOL_HEADER));
    if (mismatch) throw new CliError(mismatch);
    if (response.status >= 300 && response.status < 400)
        throw new CliError(redirectMessage(connection.url, response));
    if (!response.ok)
        throw new CliError(
            refusalMessage(connection.url, response.status, await refusalOf(response))
        );
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
        throw new CliError(
            `${connection.url} answered in a shape this CLI does not understand. Check that it is a Polaris address; if it is, run plr update.`
        );
    }
    return parsed.data;
}
