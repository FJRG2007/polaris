/**
 * The order of the conversation list, and which answer is allowed to set it.
 *
 * What is pinned: rows sort by the message they show, newest first, pinned on
 * top; a new message - somebody else's or the reader's own - moves its row up;
 * an answer to a read asked for before the one on screen never puts the list
 * back; and the read after a reconnect wins over anything older still in flight.
 */

import { describe, expect, it } from "vitest";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import {
    ConversationList,
    activityAt,
    byActivity,
    byPinThenActivity,
    mutedFields
} from "@/lib/chat/conversation-list";

/** A fixture row: only what the order reads is meaningful. */
function row(id: string, at: string | null, extra: Partial<ChatChannelView> = {}): ChatChannelView {
    return {
        id,
        pinned: false,
        lastMessageAt: at,
        last: at
            ? {
                  authorId: "someone",
                  kind: "text",
                  body: `last in ${id}`,
                  at,
                  receipts: false,
                  delivered: false,
                  read: false,
                  deleted: false
              }
            : null,
        ...extra
    } as ChatChannelView;
}

const order = (rows: readonly ChatChannelView[]): string[] =>
    [...rows].sort(byPinThenActivity).map((entry) => entry.id);

const EVENING = "2026-11-21T18:00:00.000Z";
const NOW = "2026-11-22T09:59:00.000Z";
const LATER = "2026-11-22T10:00:00.000Z";

describe("the sort key", () => {
    it("is the message the row shows, not the channel's own stamp", () => {
        // A thread reply moved the stamp; the row still shows the 6 pm message.
        const threaded = row("threaded", EVENING, { lastMessageAt: LATER });
        const recent = row("recent", NOW);
        expect(activityAt(threaded)).toBe(EVENING);
        expect(order([threaded, recent])).toEqual(["recent", "threaded"]);
    });

    it("falls back to the stamp where no message is drawn", () => {
        const channel = row("channel", null, { lastMessageAt: NOW });
        expect(activityAt(channel)).toBe(NOW);
        expect([row("old", EVENING), channel].sort(byActivity).map((entry) => entry.id)).toEqual([
            "channel",
            "old"
        ]);
    });

    it("keeps pinned rows on top and breaks ties the same way every time", () => {
        const rows = [row("b", NOW), row("a", NOW), row("pin", EVENING, { pinned: true })];
        expect(order(rows)).toEqual(["pin", "a", "b"]);
        expect(order([...rows].reverse())).toEqual(["pin", "a", "b"]);
    });
});

describe("the list as answers arrive", () => {
    it("moves a row up when somebody writes in it", () => {
        const list = new ConversationList();
        list.receive([row("ada", NOW), row("grace", EVENING)], list.ask());
        expect(order(list.rows)).toEqual(["ada", "grace"]);
        list.receive([row("ada", NOW), row("grace", LATER)], list.ask());
        expect(order(list.rows)).toEqual(["grace", "ada"]);
    });

    it("moves a row up when the reader sends in it", () => {
        const list = new ConversationList();
        list.receive([row("ada", NOW), row("grace", EVENING)], list.ask());
        const sent = row("grace", LATER, {});
        list.receive(
            [row("ada", NOW), { ...sent, last: { ...sent.last!, authorId: "me" } }],
            list.ask()
        );
        expect(order(list.rows)).toEqual(["grace", "ada"]);
        expect(list.rows.find((entry) => entry.id === "grace")?.last?.at).toBe(LATER);
    });

    it("drops an answer to a read asked for before the one on screen", () => {
        const list = new ConversationList();
        const slow = list.ask();
        const quick = list.ask();
        expect(list.receive([row("ada", NOW), row("grace", LATER)], quick)).toBe(true);
        // The slow read started before Grace's message and lands after it.
        expect(list.receive([row("ada", NOW), row("grace", EVENING)], slow)).toBe(false);
        expect(order(list.rows)).toEqual(["grace", "ada"]);
    });

    it("lets the read after a reconnect win over anything still in flight", () => {
        const list = new ConversationList();
        list.receive([row("ada", EVENING), row("grace", NOW)], list.ask());
        // Asked before the phone slept; still out when it wakes.
        const beforeSleep = list.ask();
        const afterWake = list.ask();
        list.receive([row("ada", LATER), row("grace", NOW)], afterWake);
        list.receive([row("ada", EVENING), row("grace", NOW)], beforeSleep);
        expect(order(list.rows)).toEqual(["ada", "grace"]);
    });

    it("draws a kept copy until the first answer, and never over one", () => {
        const list = new ConversationList();
        list.seed([row("kept", EVENING)]);
        expect(list.rows.map((entry) => entry.id)).toEqual(["kept"]);
        list.receive([row("fresh", NOW)], list.ask());
        list.seed([row("kept", EVENING)]);
        expect(list.rows.map((entry) => entry.id)).toEqual(["fresh"]);
    });
});

describe("a change of the reader's own", () => {
    it("shows a pin at once and keeps it through an answer asked for before it landed", () => {
        const list = new ConversationList();
        list.receive([row("ada", NOW), row("grace", EVENING)], list.ask());
        const stale = list.ask();
        const write = list.begin(new Map([["grace", { pinned: true }]]));
        expect(order(list.rows)).toEqual(["grace", "ada"]);
        list.settle(write);
        // Asked before the pin was stored: it must not flicker the pin away.
        list.receive([row("ada", NOW), row("grace", EVENING)], stale);
        expect(order(list.rows)).toEqual(["grace", "ada"]);
        // The read after the write says the same, and the overlay is no longer needed.
        list.receive([row("ada", NOW), row("grace", EVENING, { pinned: true })], list.ask());
        expect(order(list.rows)).toEqual(["grace", "ada"]);
        expect(list.rows).toBe(list.server);
    });

    it("keeps an in-flight change over any answer, then takes it back on a refusal", () => {
        const list = new ConversationList();
        list.receive([row("ada", NOW), row("grace", EVENING)], list.ask());
        const write = list.begin(new Map([["grace", { pinned: true }]]));
        list.receive([row("ada", NOW), row("grace", EVENING)], list.ask());
        expect(order(list.rows)).toEqual(["grace", "ada"]);
        list.undo(write);
        expect(order(list.rows)).toEqual(["ada", "grace"]);
    });

    it("lets the server's word stand once it has caught up, even if it differs", () => {
        const list = new ConversationList();
        list.receive([row("ada", NOW, { muted: false } as Partial<ChatChannelView>)], list.ask());
        const write = list.begin(new Map([["ada", mutedFields(60, new Date(NOW))]]));
        expect(list.rows[0]?.muted).toBe(true);
        list.settle(write);
        list.receive([row("ada", NOW, { muted: false } as Partial<ChatChannelView>)], list.ask());
        expect(list.rows[0]?.muted).toBe(false);
    });

    it("reads a mute the way the server stores it", () => {
        expect(mutedFields(null)).toEqual({ muted: false, mutedUntil: null });
        expect(mutedFields(60, new Date(NOW))).toEqual({
            muted: true,
            mutedUntil: "2026-11-22T10:59:00.000Z"
        });
    });
});
