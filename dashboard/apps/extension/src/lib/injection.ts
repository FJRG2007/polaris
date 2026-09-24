/**
 * Which sites the inline login script is allowed to run on.
 *
 * The extension asks for no standing access to anything: `host_permissions` is
 * empty and the only origin it ever reads is the Polaris somebody pointed it at.
 * Inline filling needs to run inside a page, so it runs only where that page's
 * origin has been granted by hand - and this is the rule that decides which of
 * the granted ones qualify.
 *
 * **A wildcard is never registered on.** The manifest offers a broad host pattern
 * - every scheme, every host - as an optional permission, because a browser will
 * not grant a specific origin that no optional pattern covers. A browser that has
 * been given that broad one would otherwise have the script registered for every
 * site in a single step, which is the standing reach over every page this
 * extension exists not to take. A grant that broad is permission to ask, not an
 * instruction to inject everywhere: the sites still arrive one at a time.
 *
 * **Unless somebody asked for exactly that.** "Show Polaris on every site" in
 * the popup is the one switch that does, and it is a separate, stored answer
 * (`everywhere`) rather than something read off the grant: the grant alone can
 * come from the browser's own site-access menu or from connecting a server, and
 * neither of those is somebody saying "on every page".
 *
 * Pure, so the rule can be asserted without a browser - which matters here more
 * than usual, because being wrong in the generous direction is not visible from
 * any screen.
 */

/** A host pattern that names no particular host. */
const WILDCARD = /^[a-z*]+:\/\/(\*|\*\.\*)\//i;

/** What "every site" is registered as: every web page, and nothing that is not
 *  one - no `file://`, no browser pages. */
export const EVERY_SITE = ["https://*/*", "http://*/*"] as const;

/**
 * The origins to register the inline script for.
 *
 * `granted` is what the browser reports as held, as match patterns. `dashboard`
 * is the Polaris this copy is connected to, excluded because its own sign-in page
 * does not want a fill mark over it - and because the extension already reads
 * that origin for the vault, which is a different and narrower use than running
 * a script inside it.
 *
 * `everywhere` is the stored answer from the popup's switch. With it on, each
 * broad pattern that is actually held is kept - so a switch turned on in a
 * browser that then refused the grant registers on nothing it cannot run on.
 */
export function injectableOrigins(
    granted: readonly string[],
    dashboard: string | null,
    everywhere = false
): string[] {
    const home = dashboard === null ? null : originOf(dashboard);
    const kept: string[] = [];
    if (everywhere) {
        for (const pattern of EVERY_SITE) if (granted.includes(pattern)) kept.push(pattern);
    }
    for (const pattern of granted) {
        if (typeof pattern !== "string" || pattern === "") continue;
        if (pattern === "<all_urls>" || WILDCARD.test(pattern)) continue;
        if (home !== null && originOf(pattern) === home) continue;
        if (!kept.includes(pattern)) kept.push(pattern);
    }
    return kept;
}

/** The scheme and host of a pattern or a URL, for comparing two of them. Null
 *  when it is neither, which never matches anything. */
function originOf(value: string): string | null {
    const found = /^([a-z]+):\/\/([^/*]+)/i.exec(value);
    return found ? `${found[1]?.toLowerCase()}://${found[2]?.toLowerCase()}` : null;
}
