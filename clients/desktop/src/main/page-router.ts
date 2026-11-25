/**
 * Opening a path of the Polaris in a window that already shows it.
 *
 * `loadURL` replaces the page, and with it everything the page holds: a call,
 * a draft, the scroll of every list. The dashboard keeps its call above its
 * routes (`CallHolder`), so a path that moves through its own router keeps
 * the call; only a full load takes it. So a page that said its router listens
 * (`onNavigate`) is handed the path, and is loaded over only when it never said
 * so - a dashboard older than the bridge, a page outside the shell, a page
 * that is still loading.
 *
 * What a page said lasts until it is replaced: a full navigation of its main
 * frame forgets it, so the page that comes next has to say it again.
 */

import { CHANNELS } from "@/shared/bridge";
import { isServerUrl } from "./navigation";

/** The part of a window's contents this needs; `WebContents` in the app. */
export interface RoutablePage {
    readonly id: number;
    isDestroyed(): boolean;
    getURL(): string;
    send(channel: string, ...args: unknown[]): void;
    loadURL(url: string): Promise<void>;
    once(event: "destroyed", listener: () => void): unknown;
    on(event: "did-start-navigation", listener: (details: { isMainFrame?: boolean; isSameDocument?: boolean; }) => void): unknown;
}

/** Pages whose router takes paths, by contents id. */
const listening = new Set<number>();
/** Pages already watched for being replaced, so the listeners are added once. */
const watched = new Set<number>();

/** Record whether `page`'s own router takes the paths opened in it. */
export function setRouterListening(page: RoutablePage, on: boolean): void {
    if (!on) {
        listening.delete(page.id);
        return;
    }
    listening.add(page.id);
    if (watched.has(page.id)) return;
    watched.add(page.id);
    page.once("destroyed", () => {
        listening.delete(page.id);
        watched.delete(page.id);
    });
    page.on("did-start-navigation", (details) => {
        if (details?.isMainFrame && !details.isSameDocument) listening.delete(page.id);
    });
}

/**
 * Open `url` (an address of the Polaris at `origin`) in `page`: through the
 * page's router when it listens and is on that Polaris, a full load otherwise.
 * Answers which it was.
 */
export function openInPage(page: RoutablePage, url: string, origin: string): "routed" | "loaded" {
    const target = URL.parse(url);
    if (
        target &&
        target.origin === origin &&
        listening.has(page.id) &&
        !page.isDestroyed() &&
        isServerUrl(page.getURL(), origin)
    ) {
        page.send(CHANNELS.navigate, `${target.pathname}${target.search}${target.hash}`);
        return "routed";
    }
    void page.loadURL(url).catch(() => undefined);
    return "loaded";
}
