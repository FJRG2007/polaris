"use client";

/**
 * Read one of the console's routes, and say what happened when it could not be
 * read.
 *
 * `response.ok` is not enough on its own. These routes are admin-gated, and a
 * session that has expired is answered with a redirect to the sign-in page -
 * which fetch follows, so what arrives is a perfectly fine 200 carrying HTML.
 * `json()` then throws inside an effect with nothing catching it, the rejection
 * reaches the error boundary, and a session that quietly ran out takes the whole
 * page down with "This page stopped working" rather than showing that it has
 * nothing to draw.
 *
 * Catching that is right and swallowing it is not. A console whose every read
 * failed silently holds its skeletons forever and says nothing about why - which
 * is the same dead screen the crash was, minus the clue. So a failure comes back
 * as a sentence somebody can act on, and the caller has to decide what to do with
 * it rather than treating it as "no data yet".
 */

/** A read that worked, or why it did not. `status` is the server's, absent when
 *  the request never got an answer at all. */
export type ReadResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly reason: string; readonly status?: number };

export async function readJson<T>(url: string): Promise<ReadResult<T>> {
    let response: Response;
    try {
        response = await fetch(url, { cache: "no-store" });
    } catch {
        return { ok: false, reason: "Polaris could not be reached. Check the connection and try again." };
    }
    // The content type is what separates an answer from the sign-in page standing
    // in for one: the redirect was already followed, so the status is 200 either
    // way and only the body says which happened.
    const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
    if (!response.ok) {
        return { ok: false, reason: await failureReason(response, isJson), status: response.status };
    }
    if (!isJson) {
        return { ok: false, reason: "Your session has expired. Sign in again to see this." };
    }
    try {
        return { ok: true, value: (await response.json()) as T };
    } catch {
        return { ok: false, reason: "The answer could not be read." };
    }
}

/**
 * Why a mutation failed, out of whatever was thrown.
 *
 * An error thrown out of a Server Action is rethrown in the React tree, where the
 * nearest boundary replaces the console with "This page stopped working". Every
 * handler here catches its own, and this is the sentence it shows instead.
 */
export function reasonFor(caught: unknown): string {
    return caught instanceof Error && caught.message ? caught.message : "That did not work";
}

/** The server's own sentence when it wrote one, and the status when it did not. */
async function failureReason(response: Response, isJson: boolean): Promise<string> {
    if (response.status === 401 || response.status === 403) {
        return "You do not have access to backups. Only an administrator does.";
    }
    if (isJson) {
        const body: unknown = await response.json().catch(() => null);
        const said =
            typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
                ? (body as { error: string }).error
                : "";
        if (said) return said;
    }
    return `The server answered ${response.status}.`;
}
