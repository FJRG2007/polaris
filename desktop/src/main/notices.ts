/**
 * Notices drawn by the operating system.
 *
 * Tagged the way the dashboard tags its own: a second notice with the same tag
 * replaces the first instead of stacking beside it.
 *
 * A finished deploy can be announced twice - by the push window that started it
 * and by the dashboard's alert feed - under two different tags, since neither
 * knows the other's. Both are raised with `once`, and both word it the same way
 * (see `deploy-outcome`), so the second is recognised by its words and dropped.
 */

import { Notification } from "electron";

/** How long the words of a `once` notice keep an identical one from showing. */
const ONCE_MS = 2 * 60_000;

const live = new Map<string, Notification>();
const said = new Map<string, number>();

export interface Notice {
    readonly title: string;
    readonly body?: string;
    readonly tag: string;
    readonly insistent?: boolean;
    /** True when the page already played its own sound for it. */
    readonly silent?: boolean;
    /** Drop it when a `once` notice with the same words was shown a moment ago. */
    readonly once?: boolean;
    readonly onClick?: () => void;
}

/** Whether these words were just shown, remembering them when they were not. */
function repeated(words: string): boolean {
    const now = Date.now();
    for (const [text, at] of said) if (now - at > ONCE_MS) said.delete(text);
    if (said.has(words)) return true;
    said.set(words, now);
    return false;
}

/** Show one. Answers false where the system has no notifications. */
export function showNotice(notice: Notice): boolean {
    if (!Notification.isSupported()) return false;
    if (notice.once && repeated(`${notice.title}\n${notice.body ?? ""}`)) return true;
    live.get(notice.tag)?.close();
    const shown = new Notification({
        title: notice.title,
        body: notice.body ?? "",
        silent: notice.silent ?? false,
        timeoutType: notice.insistent ? "never" : "default",
        urgency: notice.insistent ? "critical" : "normal"
    });
    shown.on("click", () => {
        notice.onClick?.();
        closeNotice(notice.tag);
    });
    shown.on("close", () => {
        if (live.get(notice.tag) === shown) live.delete(notice.tag);
    });
    live.set(notice.tag, shown);
    shown.show();
    return true;
}

export function closeNotice(tag: string): void {
    live.get(tag)?.close();
    live.delete(tag);
}
