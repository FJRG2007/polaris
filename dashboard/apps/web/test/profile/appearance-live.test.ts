/**
 * An appearance somebody changed, reaching the people looking at it.
 *
 * Until this existed, a decoration was asked for once and kept for the life of
 * the tab: you changed yours and nobody saw it until they reloaded. The fix had
 * to work without either of the two things that do not scale - pushing every
 * change to every account, or polling per account - so what is asserted here is
 * the shape that makes it cheap rather than the fact that it updates.
 *
 * The two rules:
 *
 * - A revalidation answers only what is different, out of only the faces the
 *   browser is drawing. A screen where nothing changed is one small query and an
 *   empty answer, whatever the size of the instance.
 * - "Turned everything off" is still an answer. The row is deleted when a style
 *   goes plain, so "changed since" cannot find it, and without the second half
 *   of this the ring would stay on everybody else's screen forever.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    userId: string;
    banner: string | null;
    decoration: string | null;
    nameplate: string | null;
    effect: string | null;
    nameStyle: string | null;
    updatedAt: Date;
}

let rows: Row[] = [];
/** What the last lookup was asked, so the cost of a revalidation can be
 *  asserted rather than assumed. */
const queries: { ids: string[]; since?: Date }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        userProfileStyle: {
            findMany: async ({
                where
            }: {
                where: { userId: { in: string[] }; updatedAt?: { gt: Date } };
            }) => {
                queries.push({ ids: where.userId.in, since: where.updatedAt?.gt });
                return rows.filter(
                    (row) =>
                        where.userId.in.includes(row.userId) &&
                        (!where.updatedAt || row.updatedAt > where.updatedAt.gt)
                );
            }
        }
    }
}));

const service = await import("@/lib/profile-style-service");

const ADA = "11111111-1111-4111-8111-111111111111";
const GRACE = "22222222-2222-4222-8222-222222222222";
const LIN = "33333333-3333-4333-8333-333333333333";

function styled(userId: string, at: string, decoration = "aurora"): Row {
    return {
        userId,
        banner: null,
        decoration,
        nameplate: null,
        effect: null,
        nameStyle: null,
        updatedAt: new Date(at)
    };
}

const EARLIER = new Date("2026-09-06T10:00:00Z");

beforeEach(() => {
    rows = [];
    queries.length = 0;
});

describe("what has changed since a browser last asked", () => {
    it("answers with nothing when nothing moved", async () => {
        rows = [styled(ADA, "2026-09-06T09:00:00Z")];

        const moved = await service.styleChangesSince([ADA, GRACE, LIN], EARLIER, [ADA]);

        expect(moved.changed.size).toBe(0);
        expect(moved.cleared).toEqual([]);
    });

    it("answers only the person who changed, not the page", async () => {
        rows = [styled(ADA, "2026-09-06T09:00:00Z"), styled(GRACE, "2026-09-06T10:30:00Z", "ember")];

        const moved = await service.styleChangesSince([ADA, GRACE, LIN], EARLIER, [ADA, GRACE]);

        expect([...moved.changed.keys()]).toEqual([GRACE]);
        expect(moved.changed.get(GRACE)?.decoration).toBe("ember");
    });

    it("asks about the faces on screen and nothing else", async () => {
        rows = [styled(ADA, "2026-09-06T09:00:00Z")];

        await service.styleChangesSince([ADA, GRACE], EARLIER, []);

        // The whole scaling argument in one assertion: the lookup is bounded by
        // the ids handed in, so it costs the same whether the instance has three
        // accounts or three million.
        expect(queries[0]?.ids).toEqual([ADA, GRACE]);
        expect(queries[0]?.since).toEqual(EARLIER);
    });

    it("says who has gone back to plain", async () => {
        // Grace turned everything off, so her row is gone - "changed since"
        // cannot see a row that is not there.
        rows = [styled(ADA, "2026-09-06T09:00:00Z")];

        const moved = await service.styleChangesSince([ADA, GRACE], EARLIER, [ADA, GRACE]);

        expect(moved.changed.size).toBe(0);
        expect(moved.cleared).toEqual([GRACE]);
    });

    it("only checks the ones the browser is drawing decorated", async () => {
        rows = [];

        await service.styleChangesSince([ADA, GRACE, LIN], EARLIER, [GRACE]);

        // The second lookup is over the short list, not the page: almost nobody
        // has chosen anything, so almost nobody is ever in it.
        expect(queries[1]?.ids).toEqual([GRACE]);
    });

    it("does not call somebody cleared when they are in the changed set", async () => {
        rows = [styled(ADA, "2026-09-06T10:30:00Z", "frost")];

        const moved = await service.styleChangesSince([ADA], EARLIER, [ADA]);

        expect(moved.changed.get(ADA)?.decoration).toBe("frost");
        expect(moved.cleared).toEqual([]);
    });

    it("costs one lookup and no second when nothing is drawn decorated", async () => {
        rows = [styled(ADA, "2026-09-06T09:00:00Z")];

        await service.styleChangesSince([ADA, GRACE], EARLIER, []);

        expect(queries).toHaveLength(1);
    });

    it("asks nothing at all for a screen with no faces", async () => {
        const moved = await service.styleChangesSince([], EARLIER, []);

        expect(moved.changed.size).toBe(0);
        expect(queries).toHaveLength(0);
    });
});
