/**
 * The tick under a group message, worked out from its members' read marks.
 *
 * Read only when every other member has read it; a member whose ticks are
 * withheld is unknown and never counted as having read anything; and past the
 * cap there are no ticks at all.
 */

import { describe, expect, it } from "vitest";
import {
    GROUP_RECEIPT_MAX_MEMBERS,
    memberReceiptAt,
    readersAt,
    receiptAmong,
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
            "sent"
        );
        expect(memberReceiptAt(mark("b", AFTER, AFTER, false), SENT)).toBe("unknown");
    });

    it("is sent for nobody at all", () => {
        expect(receiptAmong([], SENT)).toBe("sent");
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
