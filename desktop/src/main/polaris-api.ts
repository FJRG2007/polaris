/**
 * Calls to the Polaris Deploy API with the pasted key - the same routes the
 * `polaris` CLI calls.
 *
 * Sent through Chromium's network stack (`net`) rather than Node's, so a request
 * from here trusts the certificates and uses the proxy the window does: if the
 * dashboard opens, these reach it too.
 *
 * Only the key goes with them, never the window's session cookie: the key is
 * what the Deploy API accepts, and it can be revoked on its own.
 */

import { z } from "zod";
import { net } from "electron";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describeNetError, netErrorCode } from "./reachability";

/** A refusal or failure, with a sentence for the push window. */
export class ApiFailure extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
    }
}

export const KEY_REFUSED = "The API key was refused - it may have been revoked or have expired. Paste a new one.";

export interface Caller {
    readonly server: string;
    readonly key: string;
}

/** The failure a non-2xx answer stands for, in the instance's own words when it
 *  gave some - every Deploy API refusal is `{ "error": "..." }`. */
function refusal(status: number, body: unknown): ApiFailure {
    if (status === 401) return new ApiFailure(401, KEY_REFUSED);
    const said = body && typeof body === "object" ? (body as { error?: unknown; }).error : undefined;
    return new ApiFailure(status, typeof said === "string" ? said : `Polaris answered with HTTP ${status}.`);
}

function unreachable(caught: unknown, caller: Caller): ApiFailure {
    return new ApiFailure(0, describeNetError(netErrorCode(String(caught)), new URL(caller.server).host));
}

/**
 * A request with the key, answering the response or an `ApiFailure`.
 *
 * A streamed answer (a build log followed with `?follow=1`) arrives as it is
 * written, except that Chromium holds the first kilobyte of a `text/plain`
 * answer while it sniffs its type - so a build's first few lines can appear
 * together rather than one by one.
 */
export async function call(caller: Caller, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${caller.key}`);
    let response: Response;
    try {
        response = await net.fetch(`${caller.server}${path}`, { ...init, headers, credentials: "omit", cache: "no-store" });
    } catch (caught) {
        if ((caught as Error).name === "AbortError") throw caught;
        throw unreachable(caught, caller);
    }
    if (response.ok) return response;
    throw refusal(response.status, await response.json().catch(() => null));
}

/**
 * POST a file as the body, streamed: read from disk as the network takes it,
 * never held in memory - an image archive can be gigabytes. `net.fetch` reads a
 * stream body whole before sending it, so this uses `net.request`, whose request
 * is a writable stream with back-pressure. Answers the parsed JSON body.
 */
export async function sendFile(
    caller: Caller,
    path: string,
    body: Readable,
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal
): Promise<unknown> {
    const request = net.request({ method: "POST", url: `${caller.server}${path}`, credentials: "omit", cache: "no-store" });
    request.chunkedEncoding = true;
    request.setHeader("authorization", `Bearer ${caller.key}`);
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);

    const answered = new Promise<{ status: number; text: string; }>((resolve, reject) => {
        request.on("response", (response) => {
            let text = "";
            response.on("data", (chunk: Buffer) => {
                text += chunk.toString("utf8");
            });
            response.on("end", () => resolve({ status: response.statusCode, text }));
            response.on("error", reject);
        });
        request.on("error", reject);
        request.on("abort", () => reject(new DOMException("The upload was cancelled.", "AbortError")));
    });
    // Settled whichever way the upload goes, so a refusal mid-upload is not also
    // reported as an unhandled rejection.
    answered.catch(() => undefined);
    const abort = () => request.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
        // Electron's ClientRequest is a Writable at run time; its typings predate that.
        await pipeline(body, request as unknown as NodeJS.WritableStream);
        const { status, text } = await answered;
        let parsed: unknown = null;
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = null;
        }
        if (status < 200 || status >= 300) throw refusal(status, parsed);
        return parsed;
    } catch (caught) {
        if (signal.aborted || caught instanceof ApiFailure) throw caught;
        throw unreachable(caught, caller);
    } finally {
        signal.removeEventListener("abort", abort);
    }
}

/** A JSON answer, checked against the shape the route documents. */
export async function callJson<T>(caller: Caller, path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const response = await call(caller, path, init);
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new ApiFailure(response.status, "Polaris answered with something this app does not understand.");
    return parsed.data;
}

/** `GET /api/v1/me`: who the key acts as. */
export const meSchema = z.object({
    user: z.object({ name: z.string().nullable().optional(), username: z.string().nullable().optional() })
});

/** `GET /api/v1/deploy/services/:id/image`: the repository to tag the image under. */
export const imageTargetSchema = z.object({ repository: z.string().min(1).max(512) });

/** `POST /api/v1/deploy/services/:id/image`: the deployment that was started. */
export const startedSchema = z.object({ deploymentId: z.string().min(1).max(64) });

/** `GET /api/v1/deploy/deployments/:id?tail=1`: where a deployment is. */
export const deploymentSchema = z.object({
    status: z.string(),
    error: z.string().nullable().optional(),
    done: z.boolean(),
    nextOffset: z.number().int().nonnegative().optional()
});

export type DeploymentState = z.infer<typeof deploymentSchema>;
