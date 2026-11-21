/**
 * A plain click on a link to another site, taken before the page starts to
 * leave.
 *
 * Left to the browser, that click begins a navigation: the page's
 * `beforeunload` handlers run first, and only then does the main process see
 * the navigation, cancel it and open the address in the system browser. The
 * page never leaves, but whatever those handlers did has already happened - a
 * call hung up, a game asked "leave this site?", an editor's guard swallowed
 * the link entirely. Opening the address from here means no navigation starts.
 */

/** What a click is read from: plain values, so the rule is tested without a DOM. */
export interface LinkClick {
    readonly href: string | null;
    readonly target: string;
    readonly download: boolean;
    readonly button: number;
    readonly modified: boolean;
    readonly defaultPrevented: boolean;
    readonly pageOrigin: string;
}

const OUTSIDE = new Set(["http:", "https:", "mailto:"]);
/** Targets that load in this same window; any other opens a new one, which
 *  never unloads this page and is already sent outside by the main process. */
const SAME_WINDOW = new Set(["", "_self", "_top", "_parent"]);

/** The address to open outside, or null when the click is the page's own. */
export function outsideHref(click: LinkClick): string | null {
    if (click.defaultPrevented || click.button !== 0 || click.modified || click.download || !click.href) return null;
    if (!SAME_WINDOW.has(click.target.toLowerCase())) return null;
    let url: URL;
    try {
        url = new URL(click.href);
    } catch {
        return null;
    }
    if (!OUTSIDE.has(url.protocol)) return null;
    if (url.protocol !== "mailto:" && url.origin === click.pageOrigin) return null;
    return url.toString();
}

/**
 * Watch the page's clicks, after its own handlers (bubble phase on the window),
 * so a link the page already handled is left alone. `open` answers whether the
 * address went outside; when it did not - a page that is not the Polaris, such
 * as a provider's sign-in during a round trip - the link is followed as before.
 */
export function holdOutsideLinks(open: (url: string) => Promise<boolean>): void {
    if (typeof window === "undefined") return;
    window.addEventListener("click", (event) => {
        const anchor = event.target instanceof Element ? event.target.closest("a[href], area[href]") : null;
        if (!(anchor instanceof HTMLAnchorElement || anchor instanceof HTMLAreaElement)) return;
        const url = outsideHref({
            href: anchor.href,
            target: anchor.target,
            download: anchor.hasAttribute("download"),
            button: event.button,
            modified: event.ctrlKey || event.metaKey || event.shiftKey || event.altKey,
            defaultPrevented: event.defaultPrevented,
            pageOrigin: window.location.origin
        });
        if (!url) return;
        event.preventDefault();
        void open(url).then(
            (opened) => opened || window.location.assign(url),
            () => window.location.assign(url)
        );
    });
}
