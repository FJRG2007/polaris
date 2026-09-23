"use client";

/**
 * What this browser may draw outside its own window, and which of it.
 *
 * Permission was the only thing anybody could set: the browser had been allowed
 * or it had not, and after that Polaris decided on its own that a call, a
 * message, a piece of mail and a finished build all deserved a notice. That is
 * four different interruptions behind one yes, and the way somebody turns off the
 * one they do not want is to refuse the lot - which a browser then remembers for
 * good, taking the call notice with it.
 *
 * So each kind is its own switch, and it is kept **per device** for the same
 * reason the chime is: whether being interrupted is welcome depends on the
 * machine somebody is sitting at - a shared desk, a meeting room, a phone - and
 * not on who is signed in. A setting on the account would follow them onto a
 * screen a customer can see.
 *
 * Everything starts on. These notices existed before this file did, and a switch
 * that silently turned them off on upgrade would be Polaris going quiet without
 * anybody asking it to.
 */

/** The four things that reach past the window, as somebody would name them. */
export const NOTICE_KINDS = ["calls", "messages", "mail", "alerts"] as const;

export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** What each one is called, and what it actually covers. */
export const NOTICE_LABEL: Record<NoticeKind, { title: string; hint: string }> = {
    calls: {
        title: "Calls",
        hint: "Somebody calling you. The one that rings."
    },
    messages: {
        title: "Chat messages",
        hint: "A message in a conversation you follow, while you are on another tab."
    },
    mail: {
        title: "Mail",
        hint: "Something arriving in a mailbox you read here."
    },
    alerts: {
        title: "Everything else",
        hint: "A finished build, a server that stopped, anything the bell would carry."
    }
};

const KEY = "polaris.notices";

/** Raised at the window when a switch moves, so a card and a live connection in
 *  the same tab agree without waiting for a reload. */
export const NOTICES_CHANGED = "polaris:browser-notices";

/** Mirrors storage, so the choice still holds where a write is refused - a
 *  private window, a browser with site data blocked. */
let held: Partial<Record<NoticeKind, boolean>> | null = null;

function read(): Partial<Record<NoticeKind, boolean>> {
    if (held !== null) return held;
    held = {};
    try {
        const raw = window.localStorage.getItem(KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            for (const kind of NOTICE_KINDS) {
                if (typeof parsed[kind] === "boolean") held[kind] = parsed[kind];
            }
        }
    } catch {
        // No storage, or something that is not a setting in it. Everything is on,
        // which is what it was before there was a setting at all.
    }
    return held;
}

/** Whether this kind may be drawn outside the window on this device. */
export function noticeAllowed(kind: NoticeKind): boolean {
    if (typeof window === "undefined") return false;
    return read()[kind] ?? true;
}

/** Every switch, for the card that draws them. */
export function noticeSettings(): Record<NoticeKind, boolean> {
    const current = read();
    return Object.fromEntries(NOTICE_KINDS.map((kind) => [kind, current[kind] ?? true])) as Record<
        NoticeKind,
        boolean
    >;
}

export function setNoticeAllowed(kind: NoticeKind, allowed: boolean): void {
    const next = { ...read(), [kind]: allowed };
    held = next;
    try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
        // Refused storage only means the choice lasts for this visit.
    }
    try {
        window.dispatchEvent(new CustomEvent(NOTICES_CHANGED));
    } catch {
        // No window to tell - a server render, a test without a DOM.
    }
}

/** Told whenever a switch moves, here or in another tab. Returns the unsubscribe. */
export function onNoticesChange(listener: () => void): () => void {
    const stored = (event: StorageEvent) => {
        if (event.key !== KEY) return;
        held = null;
        listener();
    };
    window.addEventListener("storage", stored);
    window.addEventListener(NOTICES_CHANGED, listener);
    return () => {
        window.removeEventListener("storage", stored);
        window.removeEventListener(NOTICES_CHANGED, listener);
    };
}
