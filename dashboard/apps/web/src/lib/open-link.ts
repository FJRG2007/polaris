/**
 * Opening a link somewhere other than this page: a new tab in a browser, the
 * system browser (or mail app) from the desktop and phone apps.
 *
 * Every "open this link" on a Polaris screen goes through `openLink`, so each
 * client is handled in one place:
 *
 * - **Phone app.** A WebView has no tabs; a link that leaves the Polaris is
 *   handed to the phone's browser by the app (`polarisMobile.openExternal`).
 *   `window.open` there depends on how the WebView treats new windows, and a
 *   link inside a sandboxed frame (a mail body) could not open at all.
 * - **Desktop app and browser.** `window.open`: the desktop app hands any
 *   outside address to the system browser from its window-open handler.
 *
 * Only the web and mail leave: anything that is not http, https or mailto is
 * refused here, whatever the caller passed.
 *
 * Client-only.
 */

import * as mobile from "@/lib/mobile-bridge";

const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * The address a link may be opened at, resolved against `base`, or null when
 * it is not a web or mail address.
 */
export function openableUrl(href: string, base: string): URL | null {
    let url: URL;
    try {
        url = new URL(href, base);
    } catch {
        return null;
    }
    return LINK_PROTOCOLS.has(url.protocol) ? url : null;
}

/** Longest address a frame may ask to open; a real link is far shorter. */
const FRAMED_HREF_MAX = 20_000;

/**
 * What a sandboxed frame posted as a link to open, read as an absolute web or
 * mail address, or null. The frame's origin is opaque, so a relative address
 * in it means nothing and is refused rather than resolved against this page.
 */
export function framedOpenHref(claimed: unknown): string | null {
    if (typeof claimed !== "string" || claimed.length > FRAMED_HREF_MAX) return null;
    if (!/^(https?:|mailto:)/i.test(claimed)) return null;
    return openableUrl(claimed, "about:blank")?.href ?? null;
}

/**
 * Open `href` outside the current page. Resolves a relative address against
 * this page; returns false for an address that may not be opened.
 */
export function openLink(href: string): boolean {
    if (typeof window === "undefined") return false;
    const url = openableUrl(href, window.location.href);
    if (!url) return false;
    const leaves = url.protocol === "mailto:" || url.origin !== window.location.origin;
    if (leaves && mobile.openExternal(url.href)) return true;
    window.open(url.href, "_blank", "noopener,noreferrer");
    return true;
}
