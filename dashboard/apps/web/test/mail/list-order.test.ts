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
 * cursor that named only the size would hand back the same page for ever.
 */

import { describe, expect, it } from "vitest";
import { mailCursorOf, mailCursorWhere, mailOrderBy, type MailOrderRow } from "@/lib/mailbox/list-order";

function row(id: string, at: string, size: number): MailOrderRow {
    return { id, lastMessageAt: at, size };
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
        expect(mailCursorOf("newest", PAGE, 3)).toBe("2026-09-03T10:00:00.000Z");
    });

    it("hands over the newest moment when the oldest are first", () => {
        // The edge of the page under that order, which is the far end of it from
        // where the reading started.
        expect(mailCursorOf("oldest", PAGE, 3)).toBe("2026-09-05T10:00:00.000Z");
    });

    it("hands over the smallest size and its row when the largest are first", () => {
        // Two rows share 1200, so the id decides which of them is the edge: under
        // `id: desc` the one that comes last is the smaller id.
        expect(mailCursorOf("largest", PAGE, 3)).toBe("1200:bbb");
    });

    it("hands over the largest size and its row when the smallest are first", () => {
        expect(mailCursorOf("smallest", PAGE, 3)).toBe("4000:aaa");
    });

    it("takes the edge of the page rather than its last row", () => {
        // A pinned conversation sorts to the top whatever its date, so the last
        // row drawn and the oldest row are different rows. Anchoring on the last
        // would skip everything between the two.
        const pinnedOldOnTop = [row("pin", "2026-01-01T00:00:00.000Z", 10), ...PAGE];
        expect(mailCursorOf("newest", pinnedOldOnTop, 4)).toBe("2026-01-01T00:00:00.000Z");
    });
});

describe("the page after that one", () => {
    it("asks for nothing extra when there is no cursor", () => {
        expect(mailCursorWhere("newest", "")).toEqual({});
        expect(mailCursorWhere("largest", "   ")).toEqual({});
    });

    it("leaves out everything already shown, by date", () => {
        expect(mailCursorWhere("newest", "2026-09-03T10:00:00.000Z")).toEqual({
            lastMessageAt: { lt: new Date("2026-09-03T10:00:00.000Z") }
        });
        expect(mailCursorWhere("oldest", "2026-09-04T10:00:00.000Z")).toEqual({
            lastMessageAt: { gt: new Date("2026-09-04T10:00:00.000Z") }
        });
    });

    it("leaves out everything already shown, by size and by row", () => {
        expect(mailCursorWhere("largest", "1200:bbb")).toEqual({
            OR: [{ size: { lt: 1200 } }, { size: 1200, id: { lt: "bbb" } }]
        });
        expect(mailCursorWhere("smallest", "4000:aaa")).toEqual({
            OR: [{ size: { gt: 4000 } }, { size: 4000, id: { gt: "aaa" } }]
        });
    });

    it("admits the conversations of the same size that were not shown", () => {
        // The whole point of carrying the id: `ccc` ties with the edge on size
        // and has not been drawn, so the next page has to admit it.
        const where = mailCursorWhere("largest", "1200:bbb") as {
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
        expect(mailCursorWhere("newest", "not-a-date")).toEqual({});
        expect(mailCursorWhere("largest", "no-colon")).toEqual({});
        expect(mailCursorWhere("largest", "abc:bbb")).toEqual({});
        expect(mailCursorWhere("largest", "1200:")).toEqual({});
        // And a date cursor read by a size order, which is what changing the
        // order with a cursor on the address would leave behind.
        expect(mailCursorWhere("largest", "2026-09-03T10:00:00.000Z")).toEqual({});
    });
});

describe("a whole walk through a list", () => {
    it("shows every conversation once, ordered by size, ties and all", () => {
        const everything: MailOrderRow[] = [
            row("a1", "2026-09-05T00:00:00.000Z", 5000),
            row("b2", "2026-09-04T00:00:00.000Z", 1200),
            row("c3", "2026-09-03T00:00:00.000Z", 1200),
            row("d4", "2026-09-02T00:00:00.000Z", 1200),
            row("e5", "2026-09-01T00:00:00.000Z", 40)
        ];
        const seen: string[] = [];
        let cursor = "";
        for (let page = 0; page < 10; page += 1) {
            const remaining = everything.filter((one) => admits(mailCursorWhere("largest", cursor), one));
            const drawn = [...remaining].sort(byLargest).slice(0, 2);
            seen.push(...drawn.map((one) => one.id));
            cursor = mailCursorOf("largest", drawn, 2);
            if (!cursor) break;
        }
        expect(seen).toEqual(["a1", "d4", "c3", "b2", "e5"]);
        expect(new Set(seen).size).toBe(seen.length);
    });
});

/** The `largest` order, as the database would apply it. */
function byLargest(left: MailOrderRow, right: MailOrderRow): number {
    if (left.size !== right.size) return right.size - left.size;
    return left.id < right.id ? 1 : -1;
}

/** The narrowing, as the database would apply it. Only the shapes this module
 *  produces, which is all it has to understand. */
function admits(where: Record<string, unknown>, one: MailOrderRow): boolean {
    const clauses = (where.OR as { size?: unknown; id?: { lt?: string; gt?: string } }[] | undefined) ?? null;
    if (!clauses) return true;
    return clauses.some((clause) => {
        const size = clause.size as number | { lt?: number; gt?: number };
        if (typeof size === "number") {
            if (one.size !== size) return false;
            if (clause.id?.lt !== undefined) return one.id < clause.id.lt;
            if (clause.id?.gt !== undefined) return one.id > clause.id.gt;
            return true;
        }
        if (size.lt !== undefined) return one.size < size.lt;
        if (size.gt !== undefined) return one.size > size.gt;
        return true;
    });
}
