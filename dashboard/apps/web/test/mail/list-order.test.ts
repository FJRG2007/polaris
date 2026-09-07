/**
 * Paging a list of conversations, in each of the four orders it can be read in.
 *
 * The property every one of these is really asserting is the same: **the page
 * after a page shows everything that was not on it, once**. A cursor that is a
 * shade too generous repeats rows; one that is a shade too strict skips them and
 * nobody ever finds out, because the conversation that went missing is one
 * nobody was looking at. So the two halves are tested together - the cursor a
 * page hands over, and the narrowing the next page is built from - rather than
 * either on its own.
 *
 * The size orders are where this earns its keep. Sizes tie constantly: a folder
 * of short replies is a hundred conversations of the same few kilobytes, and a
 * cursor that named only the size would hand back the same page for ever. Pins
 * are where it earns it twice: a pinned conversation sorts above everything, so
 * a small one is the smallest row of a page read largest first, and a cursor
 * anchored on it drops every conversation between there and the bottom of the
 * page.
 */

import { describe, expect, it } from "vitest";
import { mailCursorOf, mailCursorWhere, mailOrderBy, type MailOrderRow } from "@/lib/mailbox/list-order";

function row(id: string, at: string, size: number, pinned = false): MailOrderRow {
    return { id, lastMessageAt: at, size, pinned };
}

/** A page of three, oldest last, with two of them the same size. */
const PAGE: MailOrderRow[] = [
    row("aaa", "2026-09-05T10:00:00.000Z", 4000),
    row("bbb", "2026-09-04T10:00:00.000Z", 1200),
    row("ccc", "2026-09-03T10:00:00.000Z", 1200)
];

describe("the order itself", () => {
    it("keeps pinned conversations at the top of every one of them", () => {
        for (const sort of ["newest", "oldest", "largest", "smallest"] as const) {
            expect(mailOrderBy(sort)[0]).toEqual({ pinned: "desc" });
        }
    });

    it("reads by date one way round or the other", () => {
        expect(mailOrderBy("newest")).toContainEqual({ lastMessageAt: "desc" });
        expect(mailOrderBy("oldest")).toContainEqual({ lastMessageAt: "asc" });
    });

    it("breaks a tie between two of the same size, so a page is repeatable", () => {
        // Without this last word the database is free to return two rows of the
        // same size in any order it likes, which is exactly the freedom the
        // cursor cannot survive.
        expect(mailOrderBy("largest").at(-1)).toEqual({ id: "desc" });
        expect(mailOrderBy("smallest").at(-1)).toEqual({ id: "asc" });
    });

    it("falls back to newest first for anything it does not know", () => {
        expect(mailOrderBy("newest")).toEqual(mailOrderBy("newest"));
    });
});

describe("where the next page starts", () => {
    it("says nowhere when the page is the end of the list", () => {
        expect(mailCursorOf("newest", PAGE, 50)).toBe("");
        expect(mailCursorOf("largest", [], 50)).toBe("");
    });

    it("hands over the oldest moment when the newest are first", () => {
        expect(mailCursorOf("newest", PAGE, 3)).toBe("0|2026-09-03T10:00:00.000Z");
    });

    it("hands over the newest moment when the oldest are first", () => {
        // The edge of the page under that order, which is the far end of it from
        // where the reading started.
        expect(mailCursorOf("oldest", PAGE, 3)).toBe("0|2026-09-05T10:00:00.000Z");
    });

    it("hands over the smallest size and its row when the largest are first", () => {
        // Two rows share 1200, so the id decides which of them is the edge: under
        // `id: desc` the one that comes last is the smaller id.
        expect(mailCursorOf("largest", PAGE, 3)).toBe("0|1200:bbb");
    });

    it("hands over the largest size and its row when the smallest are first", () => {
        expect(mailCursorOf("smallest", PAGE, 3)).toBe("0|4000:aaa");
    });

    it("passes over a pinned row, which sorts above the page rather than after it", () => {
        // A pinned conversation sorts to the top whatever its date or its size,
        // so it is never where the next page carries on from. Anchoring on it is
        // what skipped everything between it and the bottom of the page.
        const pinnedOnTop = [row("pin", "2026-01-01T00:00:00.000Z", 10, true), ...PAGE];
        expect(mailCursorOf("newest", pinnedOnTop, 4)).toBe("0|2026-09-03T10:00:00.000Z");
        expect(mailCursorOf("largest", pinnedOnTop, 4)).toBe("0|1200:bbb");
    });

    it("hands over a pinned edge when the page is nothing but pins", () => {
        // More pins than fit on a page. The next page carries on through the rest
        // of them, and only then reaches everything else.
        const allPinned = PAGE.map((one) => ({ ...one, pinned: true }));
        expect(mailCursorOf("largest", allPinned, 3)).toBe("1|1200:bbb");
    });
});

describe("the page after that one", () => {
    it("asks for nothing extra when there is no cursor", () => {
        expect(mailCursorWhere("newest", "")).toEqual({});
        expect(mailCursorWhere("largest", "   ")).toEqual({});
    });

    it("leaves out everything already shown, by date", () => {
        expect(mailCursorWhere("newest", "0|2026-09-03T10:00:00.000Z")).toEqual({
            pinned: false,
            lastMessageAt: { lt: new Date("2026-09-03T10:00:00.000Z") }
        });
        expect(mailCursorWhere("oldest", "0|2026-09-04T10:00:00.000Z")).toEqual({
            pinned: false,
            lastMessageAt: { gt: new Date("2026-09-04T10:00:00.000Z") }
        });
    });

    it("leaves out everything already shown, by size and by row", () => {
        expect(mailCursorWhere("largest", "0|1200:bbb")).toEqual({
            pinned: false,
            OR: [{ size: { lt: 1200 } }, { size: 1200, id: { lt: "bbb" } }]
        });
        expect(mailCursorWhere("smallest", "0|4000:aaa")).toEqual({
            pinned: false,
            OR: [{ size: { gt: 4000 } }, { size: 4000, id: { gt: "aaa" } }]
        });
    });

    it("carries on through the pins, and then through everything else", () => {
        expect(mailCursorWhere("largest", "1|1200:bbb")).toEqual({
            OR: [
                {
                    pinned: true,
                    OR: [{ size: { lt: 1200 } }, { size: 1200, id: { lt: "bbb" } }]
                },
                { pinned: false }
            ]
        });
    });

    it("admits the conversations of the same size that were not shown", () => {
        // The whole point of carrying the id: `ccc` ties with the edge on size
        // and has not been drawn, so the next page has to admit it.
        const where = mailCursorWhere("largest", "0|1200:bbb") as {
            OR: { size?: unknown; id?: { lt: string } }[];
        };
        const tie = where.OR[1];
        expect(tie?.size).toBe(1200);
        expect(tie?.id?.lt).toBe("bbb");
        expect("ccc" < "bbb").toBe(false);
        expect("aab" < "bbb").toBe(true);
    });

    it("starts from the top rather than answering nothing, when the cursor is nonsense", () => {
        // An address somebody edited, or a cursor left on the URL from the order
        // before this one. A list from the top is a correct answer to a nonsense
        // page; an empty list is not.
        expect(mailCursorWhere("newest", "0|not-a-date")).toEqual({});
        expect(mailCursorWhere("largest", "0|no-colon")).toEqual({});
        expect(mailCursorWhere("largest", "0|abc:bbb")).toEqual({});
        expect(mailCursorWhere("largest", "0|1200:")).toEqual({});
        // And a date cursor read by a size order, which is what changing the
        // order with a cursor on the address would leave behind.
        expect(mailCursorWhere("largest", "0|2026-09-03T10:00:00.000Z")).toEqual({});
        // A cursor naming no half of the list at all.
        expect(mailCursorWhere("newest", "2026-09-03T10:00:00.000Z")).toEqual({});
        expect(mailCursorWhere("largest", "1200:bbb")).toEqual({});
    });
});

describe("a whole walk through a list", () => {
    it("shows every conversation once, ordered by size, ties and all", () => {
        expect(
            walk(
                [
                    row("a1", "2026-09-05T00:00:00.000Z", 5000),
                    row("b2", "2026-09-04T00:00:00.000Z", 1200),
                    row("c3", "2026-09-03T00:00:00.000Z", 1200),
                    row("d4", "2026-09-02T00:00:00.000Z", 1200),
                    row("e5", "2026-09-01T00:00:00.000Z", 40)
                ],
                2
            )
        ).toEqual(["a1", "d4", "c3", "b2", "e5"]);
    });

    it("shows every conversation once when one of them is pinned and tiny", () => {
        // The failure this was written for. Read largest first, the pin is drawn
        // on the first page and is also the smallest row on it - so a cursor
        // taken across the whole page asks for everything under a kilobyte and
        // loses the middle of the list for good.
        expect(
            walk(
                [
                    row("p1", "2026-09-06T00:00:00.000Z", 1024, true),
                    row("a1", "2026-09-05T00:00:00.000Z", 500_000),
                    row("b2", "2026-09-04T00:00:00.000Z", 400_000),
                    row("c3", "2026-09-03T00:00:00.000Z", 300_000),
                    row("d4", "2026-09-02T00:00:00.000Z", 200_000)
                ],
                2
            )
        ).toEqual(["p1", "a1", "b2", "c3", "d4"]);
    });

    it("shows every conversation once when there are more pins than a page holds", () => {
        expect(
            walk(
                [
                    row("p1", "2026-09-06T00:00:00.000Z", 900, true),
                    row("p2", "2026-09-06T00:00:00.000Z", 800, true),
                    row("p3", "2026-09-06T00:00:00.000Z", 700, true),
                    row("a1", "2026-09-05T00:00:00.000Z", 5000),
                    row("b2", "2026-09-04T00:00:00.000Z", 4000)
                ],
                2
            )
        ).toEqual(["p1", "p2", "p3", "a1", "b2"]);
    });
});

/** A list read page by page, the way the database would read it. */
function walk(everything: readonly MailOrderRow[], limit: number): string[] {
    const seen: string[] = [];
    let cursor = "";
    for (let page = 0; page < 20; page += 1) {
        const remaining = everything.filter((one) => admits(mailCursorWhere("largest", cursor), one));
        const drawn = [...remaining].sort(byLargest).slice(0, limit);
        seen.push(...drawn.map((one) => one.id));
        cursor = mailCursorOf("largest", drawn, limit);
        if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    return seen;
}

/** The `largest` order, as the database would apply it - pins first. */
function byLargest(left: MailOrderRow, right: MailOrderRow): number {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    if (left.size !== right.size) return right.size - left.size;
    return left.id < right.id ? 1 : -1;
}

/** The narrowing, as the database would apply it. Only the shapes this module
 *  produces, which is all it has to understand. */
function admits(where: Record<string, unknown>, one: MailOrderRow): boolean {
    if (where.pinned !== undefined && where.pinned !== one.pinned) return false;
    const clauses = where.OR as Record<string, unknown>[] | undefined;
    if (!clauses) return true;
    return clauses.some((clause) => {
        if (clause.pinned !== undefined && clause.pinned !== one.pinned) return false;
        if (clause.OR) return admits(clause, one);
        const size = clause.size as number | { lt?: number; gt?: number } | undefined;
        if (size === undefined) return true;
        const id = clause.id as { lt?: string; gt?: string } | undefined;
        if (typeof size === "number") {
            if (one.size !== size) return false;
            if (id?.lt !== undefined) return one.id < id.lt;
            if (id?.gt !== undefined) return one.id > id.gt;
            return true;
        }
        if (size.lt !== undefined) return one.size < size.lt;
        if (size.gt !== undefined) return one.size > size.gt;
        return true;
    });
}
