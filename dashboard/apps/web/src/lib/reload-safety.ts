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
 * Two sources, because neither sees everything:
 *
 * - Holds: the screens that know they are busy say so (a recording, a file
 *   staged or on its way, an unsaved edit, a key not yet copied).
 * - What is on the page: focus inside a text field, a file on the move, a video
 *   or sound playing - each somebody in the middle of something, whether or not
 *   the screen has told anybody.
 *
 * The page's `beforeunload` guards are not probed by dispatching that event:
 * every listener would run, and some leave the page in their own way (a call
 * room hangs up on it). A screen that warns before unload holds as well.
 */

import { isUnderWay, transfersNow } from "@/components/transfers/transfer-store";

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

/** Inputs that are pressed rather than typed into: focus on one means nothing. */
const NOT_TYPED = new Set([
    "button",
    "checkbox",
    "radio",
    "range",
    "reset",
    "submit",
    "color",
    "file",
    "image"
]);

/** An element that takes typing - the one place focus means "busy". */
function isEditable(element: Element | null): boolean {
    if (!element) return false;
    if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled;
    if (element instanceof HTMLInputElement) {
        if (NOT_TYPED.has(element.type)) return false;
        return !element.readOnly && !element.disabled;
    }
    return element instanceof HTMLElement && element.isContentEditable;
}

function isPlaying(media: Element): boolean {
    return media instanceof HTMLMediaElement && !media.paused && !media.ended;
}

export function safeToReload(): boolean {
    if (holds > 0) return false;
    if (isEditable(document.activeElement)) return false;
    if (transfersNow().some(isUnderWay)) return false;
    // Somebody watching or listening is looking, even with no hand on the page.
    return ![...document.querySelectorAll("video, audio")].some((media) => isPlaying(media));
}

/** The reload itself, kept here so there is one place that leaves the page (and
 *  one place a test stands in for). */
export function reloadNow(): void {
    window.location.reload();
}
