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

/** Whether this browser can do it at all. */
export function canNotify(): boolean {
    return desktopBridge() !== null || (typeof window !== "undefined" && "Notification" in window);
}

/** Whether the person is looking at this tab right now. */
export function tabIsWatched(): boolean {
    return typeof document !== "undefined" && document.visibilityState === "visible";
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
}): Promise<{ close: () => void } | null> {
    const app = desktopBridge();
    if (app) {
        const shown = await app.notify(input).catch(() => false);
        return shown ? { close: () => void app.closeNotice(input.tag).catch(() => undefined) } : null;
    }
    if (!(await mayNotify())) return null;

    try {
        const notice = new Notification(input.title, {
            body: input.body,
            tag: input.tag,
            icon: "/polaris-mark-128.png",
            badge: "/polaris-mark-128.png",
            requireInteraction: input.insistent ?? false,
            // The sound is Polaris' own, played by the tab, and one notice that
            // also chimed would be two sounds for one event.
            silent: true
        });
        notice.onclick = () => {
            window.focus();
            if (input.href) window.location.assign(input.href);
            notice.close();
        };
        return { close: () => notice.close() };
    } catch {
        // Some browsers refuse to construct one outside a service worker.
        // Nothing to say about it: the in-app card is still there.
        return null;
    }
}
