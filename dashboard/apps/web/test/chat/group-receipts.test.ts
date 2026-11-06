/**
 * The tick under a group message, worked out from its members' read marks.
 *
 * Read only when every other member has read it; a member whose ticks are
 * withheld is unknown, never counted as having read anything, and holds the
 * tick at delivered rather than sent; and past the cap there are no ticks at all.
 */

import { describe, expect, it } from "vitest";
import {
    GROUP_RECEIPT_MAX_MEMBERS,
    memberReceiptAt,
    readersAt,
    receiptAmong,
    seenAt,
    ticksShown,
    type MemberMark
} from "@/lib/chat/group-receipts";

const SENT = new Date("2026-08-17T10:00:00Z");
const BEFORE = new Date("2026-08-17T09:59:00Z");
const AFTER = new Date("2026-08-17T10:01:00Z");

function mark(userId: string, readAt: Date | null, deliveredAt: Date | null, allowed = true) {
    return { userId, readAt, deliveredAt, allowed } satisfies MemberMark;
}

describe("receiptAmong", () => {
    it("is read when every member has read it", () => {
        expect(receiptAmong([mark("a", SENT, SENT), mark("b", AFTER, null)], SENT)).toBe("read");
    });

    it("is delivered while somebody has it but has not read it", () => {
        expect(receiptAmong([mark("a", AFTER, AFTER), mark("b", BEFORE, AFTER)], SENT)).toBe(
            "delivered"
        );
    });

    it("is sent while somebody does not have it yet", () => {
        expect(receiptAmong([mark("a", AFTER, AFTER), mark("b", null, BEFORE)], SENT)).toBe("sent");
    });

    it("never turns read on behalf of a member whose ticks are withheld", () => {
        expect(receiptAmong([mark("a", AFTER, AFTER), mark("b", AFTER, AFTER, false)], SENT)).toBe(
            "delivered"
        );
        expect(memberReceiptAt(mark("b", AFTER, AFTER, false), SENT)).toBe("unknown");
    });

    it("holds a withheld member at delivered, not sent, once the others have it", () => {
        expect(receiptAmong([mark("a", null, AFTER), mark("b", null, null, false)], SENT)).toBe(
            "delivered"
        );
        expect(receiptAmong([mark("a", null, BEFORE), mark("b", null, null, false)], SENT)).toBe(
            "sent"
        );
    });

    it("is sent for nobody at all", () => {
        expect(receiptAmong([], SENT)).toBe("sent");
    });
});

describe("seenAt", () => {
    it("is the furthest of the two marks, so marking unread takes nothing back", () => {
        expect(seenAt({ lastReadAt: BEFORE, lastSeenAt: AFTER })).toEqual(AFTER);
        expect(seenAt({ lastReadAt: AFTER, lastSeenAt: BEFORE })).toEqual(AFTER);
        expect(seenAt({ lastReadAt: null, lastSeenAt: AFTER })).toEqual(AFTER);
        expect(seenAt({ lastReadAt: SENT, lastSeenAt: null })).toEqual(SENT);
        expect(seenAt({ lastReadAt: null, lastSeenAt: null })).toBeNull();
    });
});

describe("ticksShown", () => {
    const many = (count: number) =>
        Array.from({ length: count }, (_, i) => mark(`m${i}`, null, null));

    it("holds up to the group limit and not past it", () => {
        expect(ticksShown(many(GROUP_RECEIPT_MAX_MEMBERS - 1))).toBe(true);
        expect(ticksShown(many(GROUP_RECEIPT_MAX_MEMBERS))).toBe(false);
    });

    it("is off when nobody's ticks are visible", () => {
        expect(ticksShown([mark("a", null, null, false), mark("b", null, null, false)])).toBe(
            false
        );
        expect(ticksShown([mark("a", null, null, false), mark("b", null, null)])).toBe(true);
        expect(ticksShown([])).toBe(false);
    });
});

describe("readersAt", () => {
    it("lists read first and withheld last, by name within each", () => {
        const list = readersAt(
            [
                { ...mark("z", null, null, false), name: "Zed" },
                { ...mark("b", null, AFTER), name: "Bea" },
                { ...mark("c", AFTER, AFTER), name: "Cy" },
                { ...mark("a", AFTER, AFTER), name: "Al" },
                { ...mark("d", null, null), name: "Di" }
            ],
            SENT
        );
        expect(list.map((reader) => [reader.name, reader.state])).toEqual([
            ["Al", "read"],
            ["Cy", "read"],
            ["Bea", "delivered"],
            ["Di", "sent"],
            ["Zed", "unknown"]
        ]);
    });
});
