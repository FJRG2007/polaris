/**
 * The two ends of Polar in the browser extension's side panel.
 *
 * The side panel is an extension page that frames this deployment's own
 * `/polar/embed`, so the chat in it is always the one this Polaris serves - a
 * dashboard update reaches it with no extension release. The page the person
 * has open travels from the panel to the frame by `postMessage`, and only after
 * they allowed it for that site in the panel; the frame never reaches into a
 * tab by itself.
 *
 * Both directions are checked here: the frame takes messages only from its
 * parent, only from the extension origin named in its address, and only in the
 * shape below. `next.config.mjs` writes the same origin pattern into the
 * page's `frame-ancestors`, and a test holds the two to each other.
 */

import { z } from "zod";
import { siteContextSchema, type SiteContext } from "@/lib/polar/shared";

/**
 * An extension's own origin: Chromium's 32-letter id (a-p) or Firefox's
 * per-install UUID. Nothing else may frame the embed.
 */
export const EXTENSION_ORIGIN_PATTERN =
    "chrome-extension://[a-p]{32}|moz-extension://[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const EXTENSION_ORIGIN = new RegExp(`^(?:${EXTENSION_ORIGIN_PATTERN})$`);

/** The panel's origin from the embed's `?ext=`, or null when it is not one. */
export function extensionOrigin(value: unknown): string | null {
    return typeof value === "string" && EXTENSION_ORIGIN.test(value) ? value : null;
}

/** What the panel's messages carry, so neither end answers anybody else's. */
export const FROM_EXTENSION = "polaris-extension";
export const FROM_EMBED = "polaris-embed";

const pageMessage = z.object({
    source: z.literal(FROM_EXTENSION),
    kind: z.literal("page"),
    page: z.unknown()
});

/**
 * The page a message from the panel hands over: the site context, null for
 * "nothing to share" (a browser page, a site not allowed, sharing stopped), or
 * undefined for a message that is not one of the panel's.
 */
export function pageFrom(data: unknown): SiteContext | null | undefined {
    const message = pageMessage.safeParse(data);
    if (!message.success) return undefined;
    if (message.data.page === null) return null;
    const page = siteContextSchema.safeParse(message.data.page);
    return page.success ? page.data : null;
}

/** The embed asking the panel to read the page again, for a fresh selection. */
export const REFRESH_MESSAGE = { source: FROM_EMBED, kind: "refresh" } as const;

/**
 * Whether a click on this address should leave the frame: anything but the
 * embed itself. The rest of Polaris refuses to be framed, so following a link
 * in place would leave the panel on the browser's blocked-frame page.
 */
export function opensOutside(href: string, here: string): boolean {
    let url: URL;
    try {
        url = new URL(href, here);
    } catch {
        return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const current = new URL(here);
    return !(url.origin === current.origin && url.pathname === current.pathname);
}
