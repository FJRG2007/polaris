/**
 * The meetings list: what each row is called, who may close it, what a search
 * and the filters ask the database for, and a refused delete putting the row
 * back where it stood.
 *
 * The owner's report was a scheduled meeting nobody had joined offering "End
 * meeting". Closing one is ended only once somebody is in it; before that it is
 * cancelled (in the diary) or deleted (no time, or its time passed empty).
 */

import { describe, expect, it } from "vitest";
import {
    mayManageMeeting,
    meetingListOrder,
    meetingListQuerySchema,
    meetingListWhere,
    meetingState,
    removalFor,
    restoreRow,
    withoutRow
} from "@/lib/chat/meeting-list";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const LIVE = { leftAt: null, admission: "admitted" };

describe("what a meeting is called when it is closed", () => {
    it("is ended while somebody is in it, whatever its time", () => {
        expect(removalFor(meetingState({ present: 2, scheduledAt: "2026-11-23T10:00:00Z" }, NOW))).toBe("end");
        expect(removalFor(meetingState({ present: 1, scheduledAt: "2026-11-21T10:00:00Z" }, NOW))).toBe("end");
        expect(removalFor(meetingState({ present: 1, scheduledAt: null }, NOW))).toBe("end");
    });

    it("is cancelled when it is still in the diary", () => {
        const state = meetingState({ present: 0, scheduledAt: "2026-11-23T10:00:00Z" }, NOW);
        expect(state).toBe("upcoming");
        expect(removalFor(state)).toBe("cancel");
    });

    it("is deleted when it has no time, or its time passed with nobody in it", () => {
        expect(meetingState({ present: 0, scheduledAt: null }, NOW)).toBe("open");
        expect(removalFor("open")).toBe("delete");
        expect(meetingState({ present: 0, scheduledAt: "2026-11-21T10:00:00Z" }, NOW)).toBe("past");
        expect(removalFor("past")).toBe("delete");
    });
});

describe("who may close a meeting", () => {
    it("is the host and nobody else", () => {
        expect(mayManageMeeting("ada", "ada")).toBe(true);
        expect(mayManageMeeting("ada", "grace")).toBe(false);
    });
});

describe("the list's query", () => {
    it("reads a bare request as the whole list", () => {
        expect(meetingListQuerySchema.parse({})).toEqual({});
    });

    it("trims the search and refuses one too long or an unknown filter", () => {
        expect(meetingListQuerySchema.parse({ q: "  standup " }).q).toBe("standup");
        expect(meetingListQuerySchema.safeParse({ q: "x".repeat(121) }).success).toBe(false);
        expect(meetingListQuerySchema.safeParse({ when: "tomorrow" }).success).toBe(false);
        expect(meetingListQuerySchema.safeParse({ scope: "everybody" }).success).toBe(false);
    });

    it("searches the name without regard to case", () => {
        const where = meetingListWhere("ada", { q: "standup" }, new Date(NOW), LIVE);
        expect(where.AND).toContainEqual({ title: { contains: "standup", mode: "insensitive" } });
    });

    it("never reaches past what the reader hosts or was invited to", () => {
        const all = meetingListWhere("ada", {}, new Date(NOW), LIVE);
        expect(all.AND).toContainEqual({ channelId: null, endedAt: null });
        expect(all.AND).toContainEqual({
            OR: [{ hostId: "ada" }, { invites: { some: { userId: "ada" } } }]
        });
        const mine = meetingListWhere("ada", { scope: "mine" }, new Date(NOW), LIVE);
        expect(mine.AND).toContainEqual({ hostId: "ada" });
    });

    it("keeps a running meeting whose time passed under upcoming, not past", () => {
        const now = new Date(NOW);
        const upcoming = meetingListWhere("ada", { when: "upcoming" }, now, LIVE);
        expect(upcoming.AND).toContainEqual({
            OR: [
                { scheduledAt: null },
                { scheduledAt: { gte: now } },
                { participants: { some: LIVE } }
            ]
        });
        const past = meetingListWhere("ada", { when: "past" }, now, LIVE);
        expect(past.AND).toContainEqual({ scheduledAt: { lt: now } });
        expect(past.AND).toContainEqual({ participants: { none: LIVE } });
    });

    it("sorts by time with untimed rooms last, or by name", () => {
        expect(meetingListOrder({})[0]).toEqual({ scheduledAt: { sort: "asc", nulls: "last" } });
        expect(meetingListOrder({ dir: "desc" })[0]).toEqual({
            scheduledAt: { sort: "desc", nulls: "last" }
        });
        expect(meetingListOrder({ sort: "title", dir: "desc" })[0]).toEqual({ title: "desc" });
    });
});

describe("a delete that is refused", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

    it("takes the row out at once and remembers where it stood", () => {
        expect(withoutRow(rows, "b")).toEqual({ rows: [{ id: "a" }, { id: "c" }], index: 1 });
    });

    it("puts it back in the same place", () => {
        const { rows: left, index } = withoutRow(rows, "b");
        expect(restoreRow(left, { id: "b" }, index)).toEqual(rows);
    });

    it("does not draw it twice when a reload already brought it back", () => {
        expect(restoreRow(rows, { id: "b" }, 1)).toEqual(rows);
    });

    it("puts it at the end when the list shrank under it", () => {
        expect(restoreRow([{ id: "a" }], { id: "c" }, 2)).toEqual([{ id: "a" }, { id: "c" }]);
    });
});
