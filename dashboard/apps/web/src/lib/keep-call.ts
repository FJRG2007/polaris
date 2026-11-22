"use client";

/**
 * Moving around Polaris without hanging up.
 *
 * The call is held by the shell (`CallHolder`, inside the `(app)` layout), so
 * a client navigation between screens keeps it: the screen changes, the layout
 * and the call above it stay. Three things still took it away, each one a page
 * that stopped being this page:
 *
 * - A full load to another address (`location.assign`, a plain `<a href>` that
 *   no router took). The page that wrote the call down on its way out
 *   (`call-resume`) only walks back in after a reload of the same address, so
 *   anywhere else came back as "you lost the call".
 * - A client navigation to a screen outside the `(app)` group - a public form,
 *   a print view, a share link. That screen has no shell, so the layout holding
 *   the call unmounts and the call goes with it, without a reload at all.
 * - A screen that leaves for somewhere it will take minutes to come back from
 *   (a provider's sign-in, adding another account).
 *
 * Proven web clients converge on the same answer: the call lives above the
 * router and the router never replaces the page (Discord's and Slack's voice
 * state sits in an app-wide store, not in a screen), and whatever genuinely has
 * to leave the page opens a window of its own. So, here:
 *
 * - In-app navigation goes through the router (`navigateInApp`, and the link
 *   guard for anchors nobody routed).
 * - A screen outside the shell opens in a new tab while a call is on.
 * - A full load that really is needed (an app installed: the rail and search
 *   are drawn above the page) says so first (`loadPage`), and the call is
 *   walked back into on the other side with the same microphone and camera.
 */

import { useEffect } from "react";

/** The router of the shell this tab is in, once it has mounted. */
let routerPush: ((href: string) => void) | null = null;
/** Whether this tab is on a call right now. */
let callLive = false;

const CARRY_KEY = "polaris.call.carry";
/** A full load asked for on purpose is under way within this long. */
const CARRY_MS = 15_000;

/**
 * The screens outside the `(app)` group, by the start of their path.
 *
 * Every route that is not under the shell, kept in step with the route tree by
 * a test that walks `src/app`. `/o` and `/u` are absent on purpose: the shell
 * intercepts them (`(app)/(.)o`, `(app)/(.)u`), so a profile opened from inside
 * Polaris is drawn inside it. `/api` is absent too: a route handler answers
 * with a file or a redirect, never a screen that replaces the shell on a click.
 */
export const OUTSIDE_APP_PREFIXES: readonly string[] = [
    "/about",
    "/analytics/report",
    "/c",
    "/cal",
    "/cli",
    "/continue",
    "/edge",
    "/f",
    "/forms",
    "/k",
    "/legal",
    "/m",
    "/mail/print",
    "/n",
    "/oauth",
    "/od",
    "/office/show",
    "/p",
    "/polar/embed",
    "/r",
    "/s",
    "/sa",
    "/status",
    "/t",
    "/tr",
    "/vs",
    "/wall"
];

/** Whether a path on this Polaris is drawn without the shell. */
export function isOutsideApp(pathname: string): boolean {
    return OUTSIDE_APP_PREFIXES.some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    );
}

/** A path on this Polaris (`/x`, never `//host` or another origin), or null. */
export function internalPath(href: string, base: string): URL | null {
    try {
        const url = new URL(href, base);
        if (url.origin !== new URL(base).origin) return null;
        return url;
    } catch {
        return null;
    }
}

/** The shell hands its router over; the returned function takes it back. */
export function bindRouter(push: (href: string) => void): () => void {
    routerPush = push;
    return () => {
        if (routerPush === push) routerPush = null;
    };
}

/** Kept by the call provider: whether this tab is on a call. */
export function setCallLive(live: boolean): void {
    callLive = live;
}

export function isCallLive(): boolean {
    return callLive;
}

/**
 * Say that the next page load is one this tab asked for, so a call on now is
 * walked back into on the other side whatever address it lands on.
 */
export function carryCallThroughNextLoad(): void {
    try {
        window.sessionStorage.setItem(CARRY_KEY, String(Date.now()));
    } catch {
        // Storage refused: the load still happens, the call is offered back.
    }
}

/** Whether a load asked for on purpose is under way, once: read and removed. */
export function takeCarry(): boolean {
    try {
        const at = Number(window.sessionStorage.getItem(CARRY_KEY) ?? "");
        window.sessionStorage.removeItem(CARRY_KEY);
        return Number.isFinite(at) && at > 0 && Date.now() - at <= CARRY_MS;
    } catch {
        return false;
    }
}

/**
 * Go to an address on this Polaris the way the screens' own links do.
 *
 * Through the router when it is a screen under the shell; in a new tab when it
 * is a screen outside it and a call is on; a full load otherwise (no shell
 * mounted yet, or nothing to keep).
 */
export function navigateInApp(href: string): void {
    const url = internalPath(href, window.location.href);
    const path = url ? `${url.pathname}${url.search}${url.hash}` : null;
    if (url && path && !url.pathname.startsWith("/api/") && !isOutsideApp(url.pathname) && routerPush) {
        routerPush(path);
        return;
    }
    leavePage(href);
}

/**
 * Leave for an address the page cannot be kept through: a screen outside the
 * shell, a provider's sign-in, another account. In a new tab while a call is
 * on, so the call stays where it is; in this tab otherwise, as before.
 */
export function leavePage(href: string): void {
    if (callLive) {
        window.open(href, "_blank", "noopener");
        return;
    }
    window.location.assign(href);
}

/**
 * A full load of a screen under the shell, because the shell itself changes
 * (an app installed or removed). The call is written down as one to walk back
 * into, so it comes back on the new page with the same microphone and camera.
 */
export function loadPage(href: string): void {
    if (callLive) carryCallThroughNextLoad();
    window.location.assign(href);
}

/** What a click on an anchor should become while a call is on. */
export type LinkVerdict = "leave-alone" | "new-tab" | "route";

/**
 * Decide a click on an anchor while a call is on, from what the click and the
 * link say. Pure, so every case is a test rather than a call dropped.
 *
 * `routed` is whether something already took the click (next/link prevents the
 * default for the navigations it performs itself).
 */
export function linkVerdict(input: {
    href: string | null;
    base: string;
    target: string | null;
    download: boolean;
    button: number;
    modified: boolean;
    routed: boolean;
}): LinkVerdict {
    if (!input.href || input.button !== 0 || input.modified || input.download) return "leave-alone";
    if (input.target && input.target !== "_self") return "leave-alone";
    const url = internalPath(input.href, input.base);
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return "leave-alone";
    if (url.pathname.startsWith("/api/")) return "leave-alone";
    if (isOutsideApp(url.pathname)) return "new-tab";
    if (input.routed) return "leave-alone";
    const here = new URL(input.base);
    // A jump within this same page is not a navigation at all.
    if (url.hash && url.pathname === here.pathname && url.search === here.search) return "leave-alone";
    return "route";
}

/**
 * While a call is on, keep a click on a link from replacing the page.
 *
 * Two listeners on the window, because the two cases are decided at opposite
 * ends of the click. A screen outside the shell is taken in the capture phase,
 * before next/link starts a client navigation that would unmount the shell. An
 * in-app link nobody routed (a plain `<a href>`) is taken in the bubble phase,
 * after the page's own handlers, so a link that already navigated is left be.
 */
export function useCallLinkGuard(active: boolean): void {
    useEffect(() => {
        if (!active) return;
        const read = (event: MouseEvent, routed: boolean) => {
            const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
            if (!anchor) return null;
            const verdict = linkVerdict({
                href: anchor.getAttribute("href"),
                base: window.location.href,
                target: anchor.getAttribute("target"),
                download: anchor.hasAttribute("download"),
                button: event.button,
                modified: event.metaKey || event.ctrlKey || event.shiftKey || event.altKey,
                routed
            });
            return { anchor, verdict };
        };
        const early = (event: MouseEvent) => {
            const seen = read(event, false);
            if (seen?.verdict !== "new-tab") return;
            event.preventDefault();
            event.stopPropagation();
            window.open(seen.anchor.href, "_blank", "noopener");
        };
        const late = (event: MouseEvent) => {
            const seen = read(event, event.defaultPrevented);
            if (seen?.verdict !== "route") return;
            event.preventDefault();
            navigateInApp(seen.anchor.href);
        };
        window.addEventListener("click", early, true);
        window.addEventListener("click", late);
        return () => {
            window.removeEventListener("click", early, true);
            window.removeEventListener("click", late);
        };
    }, [active]);
}
