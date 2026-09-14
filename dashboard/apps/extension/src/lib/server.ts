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
 * Reading an address is pure, and the popup needs it too - to know whether its
 * own button can be pressed - so it lives in `lib/address` and is re-exported
 * here for everything that already asks this module for it. The popup imports it
 * from there instead, and so touches neither storage nor permissions.
 */
export { readOrigin } from "@/lib/address";

/** The stored server, or null while the extension has not been told one. */
export async function currentOrigin(): Promise<string | null> {
    return ORIGIN.getValue();
}

/**
 * The asking itself is deliberately not here any more.
 *
 * A browser refuses `permissions.request` that did not come from a user gesture,
 * and this module runs in the background worker, which never has one. The comment
 * that used to sit here said as much - "must be called from a gesture, a click in
 * the popup" - while the only caller was the worker, so every first connection
 * failed with "This function must be called during a user gesture" and the popup
 * showed "Something went wrong." The popup now asks, from the click, and the
 * worker checks the answer with `holdsOrigin` below.
 */

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
