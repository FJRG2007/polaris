"use client";

/**
 * A notice the operating system draws, for the things that cannot wait for
 * somebody to look at the tab.
 *
 * A call is the case this exists for. Everything else in Polaris can be found
 * when somebody next looks at it; a call is over in thirty seconds, and a card
 * drawn inside a tab that is behind an editor is a card nobody sees. This is the
 * one mechanism a browser has for reaching past its own window.
 *
 * Two rules keep it from becoming the thing people turn off:
 *
 * - **Never asked for out of nowhere.** Permission is requested the first time
 *   something would actually be shown, so the browser's prompt arrives with a
 *   reason attached rather than on the first page load.
 * - **Only when the tab is not being looked at.** A notification about the
 *   screen somebody is reading is noise, and the in-app card is already there.
 *
 * It is also only ever raised by the tab holding the live connection - see
 * `shared-stream` - so a device with five tabs open makes one sound and draws
 * one notice.
 *
 * Inside the Polaris desktop app the notice is the app's own instead: drawn by
 * the operating system through its bridge, with no permission prompt, and a
 * press on it brings the app's window forward on the page it names.
 */

import { desktopBridge } from "@/lib/desktop-bridge";
import { attending } from "@/components/use-attention";

/**
 * The notices this device has drawn and not yet withdrawn, by tag.
 *
 * A notice about mail that has since been read is worse than no notice: it is
 * the reader being told to go and do something they have already done. The
 * browser keeps one on screen until somebody dismisses it, so whatever raised it
 * has to be able to take it back - and it cannot, unless the object it was given
 * is kept. That is this.
 *
 * Inside the desktop app there is nothing to keep: the app withdraws its own by
 * tag, which is why `closeDesktopNotice` asks it first.
 */
const shown = new Map<string, { close: () => void }>();

/** Whether this browser can do it at all. */
export function canNotify(): boolean {
    return desktopBridge() !== null || (typeof window !== "undefined" && "Notification" in window);
}

/**
 * Where this browser stands on letting Polaris draw outside its own window.
 *
 * Read on the client and never on the server, where none of it exists. Shared
 * rather than worked out at each screen: the settings card says so in words, and
 * a missed call offers the one button that mends it, and the two must not
 * disagree about what this browser has already answered.
 */
export type NoticeStanding = "app" | "granted" | "denied" | "askable" | "unsupported";

export function noticeStanding(): NoticeStanding {
    if (desktopBridge()) return "app";
    if (!canNotify()) return "unsupported";
    if (Notification.permission === "granted") return "granted";
    return Notification.permission === "denied" ? "denied" : "askable";
}

/**
 * Whether the person is looking at this tab right now: visible AND focused. A
 * window with another program on top of it is still `visible`, and a card drawn
 * there is a card nobody sees - see `components/use-attention`.
 */
export function tabIsWatched(): boolean {
    return (
        typeof document !== "undefined" && attending(document.visibilityState, document.hasFocus())
    );
}

/**
 * Ask, once, and only when there is something to show.
 *
 * A refusal is remembered by the browser, so this is cheap to call repeatedly:
 * everything after the first answer returns without prompting.
 */
export async function mayNotify(): Promise<boolean> {
    if (desktopBridge()) return true;
    if (!canNotify()) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    try {
        return (await Notification.requestPermission()) === "granted";
    } catch {
        return false;
    }
}

/**
 * Draw one, and answer with a way to take it back.
 *
 * Taking it back matters for a call: the notice for a call that has already been
 * answered somewhere else, or that rang out, should not sit there afterwards
 * offering to join a room nobody is in.
 */
export async function notifyDesktop(input: {
    title: string;
    body?: string;
    /** Notices sharing a tag replace each other rather than stacking, which is
     *  what stops six messages from one conversation becoming six notices. */
    tag: string;
    /** Where pressing it goes. The tab is focused either way. */
    href?: string;
    /** Whether it stays until it is dealt with. True for a call. */
    insistent?: boolean;
    /**
     * Whether the notice makes a sound of its own.
     *
     * Off by default, because the tab chimes for what it draws and one event
     * with two sounds is worse than either of them. A call is the exception, and
     * it is the exception for the reason this whole module exists: a notice is
     * only ever raised when nobody is looking at the tab, and a tab nobody is
     * looking at is one whose audio the browser is free to suspend. Polaris' own
     * ring is then notes scheduled into a context that is not running - nothing
     * comes out of the speakers at all - so a silent notice made a call the one
     * thing in Polaris that could pass in complete silence, which is the one
     * thing a call must never do.
     */
    sound?: boolean;
}): Promise<{ close: () => void } | null> {
    const app = desktopBridge();
    if (app) {
        const drawn = await app.notify(input).catch(() => false);
        if (!drawn) return null;
        const handle = { close: () => void app.closeNotice(input.tag).catch(() => undefined) };
        shown.set(input.tag, handle);
        return handle;
    }
    if (!(await mayNotify())) return null;

    try {
        const notice = new Notification(input.title, {
            body: input.body,
            tag: input.tag,
            icon: "/polaris-mark-128.png",
            badge: "/polaris-mark-128.png",
            requireInteraction: input.insistent ?? false,
            // Silent unless the caller says otherwise: the sound is normally
            // Polaris' own, played by the tab, and one notice that also chimed
            // would be two sounds for one event. See `sound`.
            silent: !(input.sound ?? false)
        });
        notice.onclick = () => {
            window.focus();
            if (input.href) window.location.assign(input.href);
            notice.close();
        };
        const handle = {
            close: () => {
                shown.delete(input.tag);
                notice.close();
            }
        };
        // Dismissed by hand, or by the system: either way it is no longer
        // something to withdraw.
        notice.onclose = () => shown.delete(input.tag);
        shown.set(input.tag, handle);
        return handle;
    } catch {
        // Some browsers refuse to construct one outside a service worker.
        // Nothing to say about it: the in-app card is still there.
        return null;
    }
}

/**
 * Take one back.
 *
 * For the thing it was about having been dealt with - a call that was answered,
 * a message that was read - which is the only honest moment to withdraw a
 * notice. Silent about a tag nothing drew: the caller says what happened, and
 * whether there was a notice for it is this module's business.
 */
export function closeDesktopNotice(tag: string): void {
    const app = desktopBridge();
    if (app) void app.closeNotice(tag).catch(() => undefined);
    const held = shown.get(tag);
    if (!held) return;
    shown.delete(tag);
    held.close();
}
