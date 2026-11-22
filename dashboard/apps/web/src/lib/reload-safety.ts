/**
 * Whether reloading this tab right now would cost somebody something.
 *
 * Picking up a new build is a reload, and a reload is free only when nothing on
 * the page is still in the reader's hands: no half-typed field, no recording
 * running, no file on its way up or down, no unsaved edit. When all of that is
 * clear the tab can take the update by itself - the reader comes back to the
 * same address on the new build and never sees a refused click. When any of it
 * is not, the tab keeps offering instead.
 *
 * Three sources, because none sees everything:
 *
 * - Holds: the screens that know they are busy say so (a recording, a file
 *   staged or on its way, an unsaved edit, a key not yet copied).
 * - The page itself (`lib/work-in-progress`): any field changed and not saved,
 *   focused or not, an open dialog, a save or server action still on its way.
 *   No screen has to report these, so none can forget to.
 * - A file on the move, a video or sound playing.
 *
 * Focus alone is not work: an empty box the cursor sits in loses nothing. And
 * whatever is unsaved is also written down when the page goes away and put back
 * after it (`saveUnsavedFields`), so even a reload nobody chose loses nothing.
 *
 * The page's `beforeunload` guards are not probed by dispatching that event:
 * every listener would run, and some leave the page in their own way (a call
 * room hangs up on it). A screen that warns before unload holds as well.
 */

import { isUnderWay, transfersNow } from "@/components/transfers/transfer-store";
import * as work from "@/lib/work-in-progress";

export { RELOAD_KEEPS_ATTRIBUTE } from "@/lib/work-in-progress";

let holds = 0;

/** Keep the tab from reloading by itself until the returned release is called.
 *  Release is idempotent, so an effect cleanup can call it without counting. */
export function holdReload(): () => void {
    holds += 1;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        holds -= 1;
    };
}

function isPlaying(media: Element): boolean {
    return media instanceof HTMLMediaElement && !media.paused && !media.ended;
}

export function safeToReload(): boolean {
    if (holds > 0) return false;
    if (work.dirtyFields().length > 0 || work.dialogOpen() || work.writesUnderWay()) return false;
    if (transfersNow().some(isUnderWay)) return false;
    // Somebody watching or listening is looking, even with no hand on the page.
    return ![...document.querySelectorAll("video, audio")].some((media) => isPlaying(media));
}

/** What `reloadNow` writes down for the page that replaces this one. Session
 *  storage: it is this tab's, survives the reload and dies with the tab. */
const SNAPSHOT_KEY = "polaris.reloadSnapshot";

/** Older than this, a snapshot belongs to some other visit and is ignored. */
const SNAPSHOT_TTL_MS = 60_000;

/** How long the new page is watched for a scroller to appear:
 *  a screen that loads its data after the shell draws them late. */
const RESTORE_WINDOW_MS = 8_000;

/** Scrolled areas worth putting back besides the window: the shell's main
 *  column and any screen that names its own scroller. */
const SCROLLERS = "main, [data-reload-scroll]";

interface ReloadSnapshot {
    readonly url: string;
    readonly at: number;
    readonly scroll: readonly { readonly selector: string; readonly top: number }[];
}

function scrollerKey(element: Element, index: number): string {
    const named = element.getAttribute("data-reload-scroll");
    return named ? `[data-reload-scroll="${CSS.escape(named)}"]` : `main:nth-of-type(${index + 1})`;
}

/** Read the scroll positions a reload of this tab would put back. Exported for the test. */
export function takeSnapshot(): ReloadSnapshot {
    const scroll = [{ selector: ":root", top: window.scrollY }];
    document.querySelectorAll(SCROLLERS).forEach((element, index) => {
        if (element.scrollTop > 0) scroll.push({ selector: scrollerKey(element, index), top: element.scrollTop });
    });
    return { url: location.pathname + location.search, at: Date.now(), scroll };
}

/**
 * Put back what the page before this one wrote down: the scroll positions,
 * once each exists, and every unsaved field (`lib/work-in-progress`). Also
 * starts watching this page's own work in progress.
 * Nothing happens on a visit that did not come from that reload.
 */
export function restoreAfterReload(): () => void {
    work.watchWorkInProgress();
    const stopFields = work.restoreUnsavedFields();
    let snapshot: ReloadSnapshot | null = null;
    try {
        const raw = window.sessionStorage.getItem(SNAPSHOT_KEY);
        window.sessionStorage.removeItem(SNAPSHOT_KEY);
        snapshot = raw ? (JSON.parse(raw) as ReloadSnapshot) : null;
    } catch {
        return stopFields;
    }
    if (!snapshot || typeof snapshot.at !== "number" || Date.now() - snapshot.at > SNAPSHOT_TTL_MS) return stopFields;
    if (snapshot.url !== location.pathname + location.search) return stopFields;
    const scroll = Array.isArray(snapshot.scroll) ? [...snapshot.scroll] : [];
    const started = Date.now();
    const settle = (): boolean => {
        for (let index = scroll.length - 1; index >= 0; index--) {
            const { selector, top } = scroll[index]!;
            const element = selector === ":root" ? document.scrollingElement : document.querySelector(selector);
            if (!element || element.scrollHeight - element.clientHeight < top) continue;
            element.scrollTop = top;
            scroll.splice(index, 1);
        }
        return scroll.length === 0;
    };
    if (settle()) return stopFields;
    const timer = setInterval(() => {
        if (settle() || Date.now() - started > RESTORE_WINDOW_MS) clearInterval(timer);
    }, 200);
    return () => {
        clearInterval(timer);
        stopFields();
    };
}

/** The reload itself, kept here so there is one place that leaves the page (and
 *  one place a test stands in for). Writes down what the next page puts back. */
export function reloadNow(): void {
    work.saveUnsavedFields();
    try {
        window.sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(takeSnapshot()));
    } catch {
        // Nowhere to write it: the reload still happens, and safeToReload has
        // already refused it for anything typed that would be lost.
    }
    window.location.reload();
}
