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
 * Only a notice from the other announcer is dropped, and only one: two deploys
 * of the same service read the same too, and each is announced.
 */

import { Notification } from "electron";
import { OnceNotices } from "./notice-once";

const live = new Map<string, Notification>();
const said = new OnceNotices();

export interface Notice {
    readonly title: string;
    readonly body?: string;
    readonly tag: string;
    readonly insistent?: boolean;
    /** True when the page already played its own sound for it. */
    readonly silent?: boolean;
    /** Drop it when the other announcer showed a `once` notice with the same
     *  words a moment ago (see `notice-once`). */
    readonly once?: boolean;
    readonly onClick?: () => void;
    /** A field on the notice to answer in, and what the answer is handed to. */
    readonly reply?: { readonly placeholder: string; readonly onReply: (text: string) => void; };
    /** Buttons on the notice, and what a press on one is handed to, by id. */
    readonly actions?: readonly { readonly id: string; readonly text: string }[];
    readonly onAction?: (action: string) => void;
}

/** Show one. Answers false where the system has no notifications. */
export function showNotice(notice: Notice): boolean {
    if (!Notification.isSupported()) return false;
    if (notice.once && said.repeated(notice.tag, `${notice.title}\n${notice.body ?? ""}`)) return true;
    live.get(notice.tag)?.close();
    const shown = new Notification({
        title: notice.title,
        body: notice.body ?? "",
        silent: notice.silent ?? false,
        timeoutType: notice.insistent ? "never" : "default",
        urgency: notice.insistent ? "critical" : "normal",
        ...(notice.reply ? { hasReply: true, replyPlaceholder: notice.reply.placeholder } : {}),
        ...(notice.actions?.length
            ? { actions: notice.actions.map((one) => ({ type: "button" as const, text: one.text })) }
            : {})
    });
    const { actions, onAction } = notice;
    if (actions?.length && onAction) {
        shown.on("action", (details, index) => {
            const pressed = actions[details?.actionIndex ?? index];
            if (!pressed) return;
            onAction(pressed.id);
            closeNotice(notice.tag);
        });
    }
    if (notice.reply) {
        const { onReply } = notice.reply;
        shown.on("reply", (_event, text) => {
            onReply(text);
            closeNotice(notice.tag);
        });
    }
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
