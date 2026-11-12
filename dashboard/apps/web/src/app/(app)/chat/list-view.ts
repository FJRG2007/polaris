"use client";

/**
 * How the conversation list draws its rows: compact, the way the rail always
 * has, or detailed - a face, the last message and when, the way a messenger
 * lists its chats.
 *
 * Remembered for this browser, like Mail's reading layout
 * (`mail/use-mail-layout.ts`), and for the same reason: a phone and a desk are
 * not the same shape. "Auto" decides by how wide the list has been dragged.
 */

import { useCallback, useEffect, useState } from "react";

export type ChatListView = "auto" | "compact" | "detailed";

const KEY = "polaris.chat.listView";

/** From this width up, "auto" draws the detailed rows. */
export const DETAILED_FROM = 300;

export function isChatListView(value: unknown): value is ChatListView {
    return value === "auto" || value === "compact" || value === "detailed";
}

/**
 * How far below DETAILED_FROM "auto" goes before it gives the detailed rows up.
 *
 * Without it the list can flip for ever: detailed rows are taller, so they bring
 * the pane's scrollbar in, the scrollbar takes its width off the rows, the rows
 * are now under the line and go compact, the scrollbar leaves, the width is
 * back over the line - every frame, which is a window that stops answering.
 * Wider than any scrollbar a desktop draws.
 */
export const DETAILED_HYSTERESIS = 24;

/**
 * Whether "auto" draws the detailed rows at this width, given what it drew
 * before: in at DETAILED_FROM, out only once well below it.
 */
export function autoDetailed(wasDetailed: boolean, width: number): boolean {
    return width >= (wasDetailed ? DETAILED_FROM - DETAILED_HYSTERESIS : DETAILED_FROM);
}

/** Whether a list this wide, under this setting, draws the detailed rows. */
export function drawsDetailed(view: ChatListView, width: number): boolean {
    return view === "detailed" || (view === "auto" && width >= DETAILED_FROM);
}

/**
 * How wide the list pane is made when a view is picked from its menu, or null
 * to leave it where it was dragged. Detailed rows need room for a face, the
 * last message and its time, so a narrower pane is widened to fit them (held to
 * what the window allows); compact rows give that room back. "Auto" never
 * moves it: it follows the width instead of setting one.
 */
export const DETAILED_PANE = 336;
export const COMPACT_PANE = 256;

export function paneWidthFor(view: ChatListView, drawn: number, ceiling: number): number | null {
    if (view === "detailed") return drawn < DETAILED_PANE ? Math.min(DETAILED_PANE, ceiling) : null;
    if (view === "compact") return drawn > COMPACT_PANE ? COMPACT_PANE : null;
    return null;
}

export function useChatListView(): [ChatListView, (next: ChatListView) => void] {
    const [view, setView] = useState<ChatListView>("auto");

    useEffect(() => {
        try {
            const held = window.localStorage.getItem(KEY);
            if (isChatListView(held)) setView(held);
        } catch {
            // Storage that will not answer is the default, not an error.
        }
    }, []);

    const choose = useCallback((next: ChatListView) => {
        setView(next);
        try {
            window.localStorage.setItem(KEY, next);
        } catch {
            // Kept for this page then, which is still what was asked for.
        }
    }, []);

    return [view, choose];
}

const DAY_MS = 86_400_000;

function startOfDay(date: Date): number {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * When the last message was, the way a chat list says it: the time today,
 * "Yesterday", the weekday within the week, the date before that.
 */
export function listTime(iso: string, now: Date, locale: string, yesterday: string): string {
    const at = new Date(iso);
    const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
    if (days <= 0) {
        return new Intl.DateTimeFormat(locale, {
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23"
        }).format(at);
    }
    if (days === 1) return yesterday;
    if (days < 7) return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(at);
    return new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "numeric",
        year: "2-digit"
    }).format(at);
}
