/**
 * Which Polaris this extension belongs to, and permission to reach it.
 *
 * A hosted password manager knows its own address. A self-hosted one cannot: the
 * server is on somebody's own domain, or on a name that only resolves inside
 * their house, and the extension is told which one it is after it is installed.
 * So the origin is stored, and the permission to talk to it is asked for at that
 * moment rather than declared in the manifest - the difference between "this
 * extension may read one server you named" and "this extension may read every
 * page you open", which is what a wildcard host permission would have meant.
 *
 * Everything in here runs in the background worker. A content script has no
 * business holding the server address and could not ask for a permission anyway.
 */

import { storage } from "#imports";

/** Where the vault answers, as an origin with no trailing slash. */
const ORIGIN = storage.defineItem<string | null>("local:server.origin", {
    fallback: null
});

/**
 * Turn what somebody typed into an origin, or refuse it.
 *
 * People type `polaris.local`, `https://polaris.example.com/vault`, and their
 * address with a path on the end because that is what the browser showed them.
 * All three mean the same server. What is refused is anything that is not a URL
 * at all, so the failure happens here with a sentence rather than later as a
 * fetch nobody can explain.
 */
export function readOrigin(typed: string): string | null {
    const trimmed = typed.trim();
    if (trimmed === "") return null;
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
        const url = new URL(withScheme);
        if (url.protocol !== "https:" && url.protocol !== "http:") return null;
        if (url.hostname === "") return null;
        return url.origin;
    } catch {
        return null;
    }
}

/** The stored server, or null while the extension has not been told one. */
export async function currentOrigin(): Promise<string | null> {
    return ORIGIN.getValue();
}

/**
 * Ask the browser for the one origin this extension needs.
 *
 * Must be called from a gesture - a click in the popup - because a browser
 * refuses a permission request that did not come from one. Returns whether it
 * was granted; a refusal is a normal answer and not an error.
 */
export async function grantOrigin(origin: string): Promise<boolean> {
    return browser.permissions.request({ origins: [`${origin}/*`] });
}

/** Whether the extension already holds permission for this origin. */
export async function holdsOrigin(origin: string): Promise<boolean> {
    return browser.permissions.contains({ origins: [`${origin}/*`] });
}

/** Remember the server, once it has answered and been granted. */
export async function rememberOrigin(origin: string): Promise<void> {
    await ORIGIN.setValue(origin);
}

/** Forget it, on signing out of this server for good. */
export async function forgetOrigin(): Promise<void> {
    await ORIGIN.setValue(null);
}

/**
 * The base every vault path hangs off.
 *
 * `/vault` is the address a Bitwarden client is pointed at and the one Polaris
 * documents; the rest (`/vault/api`, `/vault/identity`) is derived from it the
 * same way every other client derives it.
 */
export function vaultBase(origin: string): string {
    return `${origin}/vault`;
}
