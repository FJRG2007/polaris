/**
 * How the subscription logins reach their vendors: the guarded fetch (public
 * addresses only, no redirects), a timeout and a capped read. Nothing sent or
 * received is logged. The login modules take a `LoginRequest` so tests hand in
 * recorded answers instead.
 */

import { configuredRequest, readCapped } from "@/lib/safe-fetch";
import type { DirectPost, DirectResponse } from "@/lib/agents/signin-direct";

export interface LoginInit {
    readonly method: "GET" | "POST";
    readonly headers?: Record<string, string>;
    readonly json?: Record<string, unknown>;
    readonly form?: Record<string, string>;
}

export type LoginRequest = (url: string, init: LoginInit) => Promise<DirectResponse>;

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 64 * 1024;

export const loginRequest: LoginRequest = async (url, init) => {
    const headers: Record<string, string> = { ...init.headers };
    let body: string | undefined;
    if (init.json) {
        headers["content-type"] ??= "application/json";
        body = JSON.stringify(init.json);
    } else if (init.form) {
        headers["content-type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams(init.form).toString();
    }
    const response = await configuredRequest(
        url,
        { method: init.method, headers, body, timeoutMs: TIMEOUT_MS },
        { allowPrivate: false }
    );
    const bytes = await readCapped(response as unknown as Parameters<typeof readCapped>[0], MAX_BYTES);
    let json: unknown = null;
    try {
        json = bytes ? JSON.parse(Buffer.from(bytes).toString("utf8")) : null;
    } catch {
        json = null;
    }
    return { status: response.status, json };
};

/** The same request in the shape the xAI module (and the ChatGPT login) take. */
export function asDirectPost(request: LoginRequest): DirectPost {
    return (url, body) =>
        request(url, "json" in body ? { method: "POST", json: body.json } : { method: "POST", form: body.form });
}
