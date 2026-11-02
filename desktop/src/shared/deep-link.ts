/**
 * `polaris://open?server=<origin>&path=<path>`: a page of a Polaris, opened in this
 * app by something else on the computer, such as the Stream Deck plugin.
 *
 * Any website can start such a link, so it only ever names a page to show: it
 * carries nothing, a page acts only on what somebody then presses, and a page on
 * another Polaris kept here opens only after a yes (`main/deep-links`).
 */

export const DEEP_LINK_SCHEME = "polaris";

export interface DeepLink {
    readonly server: string;
    readonly path: string;
}

/** What a link asks for, or null when it is not one of ours. */
export function readDeepLink(value: unknown): DeepLink | null {
    if (typeof value !== "string" || value.length > 2048) return null;
    try {
        const link = new URL(value);
        if (link.protocol !== `${DEEP_LINK_SCHEME}:` || link.hostname !== "open") return null;
        const server = new URL(link.searchParams.get("server") ?? "");
        if (server.protocol !== "https:" && server.protocol !== "http:") return null;
        if (server.username || server.password) return null;
        const path = link.searchParams.get("path") ?? "/";
        if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
        return { server: server.origin, path };
    } catch {
        return null;
    }
}

/** The link among a process's arguments, which is how Windows and Linux hand it over. */
export function deepLinkIn(argv: readonly string[]): DeepLink | null {
    for (const argument of argv) {
        if (!argument.startsWith(`${DEEP_LINK_SCHEME}://`)) continue;
        const link = readDeepLink(argument);
        if (link) return link;
    }
    return null;
}
