/**
 * A change outlives every answer that could not know about it.
 *
 * The reports: a message opened and left at once went back to bold, and a
 * conversation just deleted came back. Both were the screen dropping its
 * overlay because a list arrived - a list that had been asked for before the
 * change was confirmed: the copy the tab or the device kept, a refresh the live
 * channel started a moment earlier, the one closing the reading pane triggers.
 *
 * The rule pinned here: an answer may contradict a change only if it was
 * requested after the server confirmed it. Each race is a test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    SETTLED_KEEP_MS,
    beginChange,
    overlaysFor,
    pendingChanges,
    pendingChangesVersion,
    resetPendingChanges,
    subscribePendingChanges
} from "@/app/(app)/mail/pending-changes";

const T0 = 1_800_000_000_000;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    resetPendingChanges();
});
afterEach(() => vi.useRealTimers());

const owed = (requestedAt: number) => overlaysFor(pendingChanges(), requestedAt, Date.now());

describe("reading a message and leaving at once", () => {
    it("stays read over a list asked for before the server answered", () => {
        const pending = beginChange(["t1"], { unreadCount: 0 });
        // Leaving closes the pane, which asks for the list: it lands before the
        // mark has, and still says unread.
        expect(owed(T0 + 10)).toEqual({ t1: { unreadCount: 0 } });

        vi.setSystemTime(T0 + 500);
        pending.settle();
        // The same list, arriving after the answer: still older than it.
        expect(owed(T0 + 10)).toEqual({ t1: { unreadCount: 0 } });
        // A copy kept on the device has no stamp and is older than everything.
        expect(owed(0)).toEqual({ t1: { unreadCount: 0 } });
    });

    it("lets a list asked for after the answer speak for itself", () => {
        const pending = beginChange(["t1"], { unreadCount: 0 });
        vi.setSystemTime(T0 + 500);
        pending.settle();
        expect(owed(T0 + 501)).toEqual({});
    });

    it("goes back to bold when the server refuses", () => {
        const pending = beginChange(["t1"], { unreadCount: 0 });
        pending.abandon();
        expect(owed(T0 - 1)).toEqual({});
    });
});

describe("deleting a conversation", () => {
    it("keeps it hidden from every list asked for before the delete was confirmed", () => {
        const pending = beginChange(["t1", "t2"], { gone: true });
        vi.setSystemTime(T0 + 2_000);
        pending.settle();
        // A list fetched by the live channel while the delete was in the air.
        expect(owed(T0 + 1_000)).toEqual({ t1: { gone: true }, t2: { gone: true } });
        // Another view's kept copy, painted on the way back to it.
        expect(owed(T0 - 60_000)).toEqual({ t1: { gone: true }, t2: { gone: true } });
    });

    it("puts the rows back at once when the server refuses", () => {
        const pending = beginChange(["t1"], { gone: true });
        pending.abandon();
        expect(owed(0)).toEqual({});
    });

    it("forgets it once no list on screen could predate it", () => {
        const pending = beginChange(["t1"], { gone: true });
        pending.settle();
        vi.setSystemTime(T0 + SETTLED_KEEP_MS + 1);
        expect(owed(0)).toEqual({});
    });
});

describe("several changes at once", () => {
    it("keeps each one on its own, so a refusal takes back only its own", () => {
        const star = beginChange(["t1"], { starred: true });
        const read = beginChange(["t1", "t2"], { unreadCount: 0 });
        star.abandon();
        expect(owed(0)).toEqual({ t1: { unreadCount: 0 }, t2: { unreadCount: 0 } });
        read.settle();
        expect(owed(Date.now() + 1)).toEqual({});
    });

    it("lays a later change over an earlier one on the same row", () => {
        beginChange(["t1"], { unreadCount: 0 });
        beginChange(["t1"], { unreadCount: 1 });
        expect(owed(0)).toEqual({ t1: { unreadCount: 1 } });
    });

    it("tells a screen when the ledger moves, and ignores a second answer", () => {
        const listener = vi.fn();
        const stop = subscribePendingChanges(listener);
        const before = pendingChangesVersion();
        const pending = beginChange(["t1"], { starred: true });
        pending.settle();
        pending.settle();
        pending.abandon();
        expect(listener).toHaveBeenCalledTimes(2);
        expect(pendingChangesVersion()).toBe(before + 2);
        // The yes stands.
        expect(pendingChanges()[0]?.settledAt).toBe(Date.now());
        stop();
    });

    it("records nothing for a change aimed at no conversation", () => {
        beginChange([], { gone: true });
        expect(pendingChanges()).toHaveLength(0);
    });
});
