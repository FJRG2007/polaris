"use client";

/**
 * Read one of the console's routes, or nothing.
 *
 * `response.ok` is not enough on its own. These routes are admin-gated, and a
 * session that has expired is answered with a redirect to the sign-in page -
 * which fetch follows, so what arrives is a perfectly fine 200 carrying HTML.
 * `json()` then throws inside an effect with nothing catching it, the rejection
 * reaches the error boundary, and a session that quietly ran out takes the whole
 * page down with "This page stopped working" rather than showing that it has
 * nothing to draw.
 *
 * A dropped connection did the same thing, for the same reason. Both come back
 * as null here, which every caller already had a state for.
 */
export async function readJson<T>(url: string): Promise<T | null> {
    try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) return null;
        // The content type is what separates an answer from the sign-in page
        // standing in for one.
        if (!(response.headers.get("content-type") ?? "").includes("application/json")) return null;
        return (await response.json()) as T;
    } catch {
        return null;
    }
}
