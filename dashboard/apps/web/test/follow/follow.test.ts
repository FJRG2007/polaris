/**
 * Who hears about something.
 *
 * The one that matters is idempotence. `follow` is called from paths that mean
 * "make sure this person hears about it" - commenting, being handed a comment,
 * a rule adding somebody - as much as from a switch, so calling it twice must
 * not fail. And the second call must not rewrite why they are following: having
 * commented is still the true reason after they later press Follow.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const followUpsert = vi.fn(async (_args: unknown) => ({}));
const followDeleteMany = vi.fn(async (_args: unknown) => ({ count: 0 }));
const followFindUnique = vi.fn(async (_args: unknown) => null as unknown);
const followFindMany = vi.fn(async (_args: unknown) => [] as unknown[]);

vi.mock("@polaris/db", () => ({
    prisma: {
        follow: {
            upsert: followUpsert,
            deleteMany: followDeleteMany,
            findUnique: followFindUnique,
            findMany: followFindMany
        }
    }
}));

const follow = await import("../../src/lib/follow/follow");

beforeEach(() => {
    vi.clearAllMocks();
});

describe("following", () => {
    it("records the reason on the way in", async () => {
        await follow.follow("task", "t1", "u1", "commented");

        expect(followUpsert).toHaveBeenCalledWith({
            where: { subjectType_subjectId_userId: { subjectType: "task", subjectId: "t1", userId: "u1" } },
            update: {},
            create: { subjectType: "task", subjectId: "t1", userId: "u1", reason: "commented" }
        });
    });

    it("leaves the reason alone when they already follow it", async () => {
        await follow.follow("service", "s1", "u1");

        const call = followUpsert.mock.calls[0]?.[0] as { update: Record<string, unknown> };
        expect(call.update).toEqual({});
    });

    it("defaults to having asked", async () => {
        await follow.follow("service", "s1", "u1");

        const call = followUpsert.mock.calls[0]?.[0] as { create: { reason: string } };
        expect(call.create.reason).toBe("explicit");
    });

    it("unfollows without minding whether they were", async () => {
        await follow.unfollow("service", "s1", "u1");

        expect(followDeleteMany).toHaveBeenCalledWith({
            where: { subjectType: "service", subjectId: "s1", userId: "u1" }
        });
    });
});

describe("who is following", () => {
    it("answers yes or no rather than the row", async () => {
        followFindUnique.mockResolvedValueOnce({ userId: "u1" });
        expect(await follow.isFollowing("service", "s1", "u1")).toBe(true);

        followFindUnique.mockResolvedValueOnce(null);
        expect(await follow.isFollowing("service", "s1", "u2")).toBe(false);
    });

    it("leaves out whoever caused the thing being announced", async () => {
        followFindMany.mockResolvedValueOnce([{ userId: "u1" }, { userId: "u2" }]);

        expect(await follow.followers("service", "s1", "u1")).toEqual(["u2"]);
    });

    it("keeps everybody when nobody is excluded", async () => {
        followFindMany.mockResolvedValueOnce([{ userId: "u1" }, { userId: "u2" }]);

        expect(await follow.followers("service", "s1")).toEqual(["u1", "u2"]);
    });
});

describe("forgetting", () => {
    it("takes one subject or a list of them", async () => {
        await follow.forget("service", "s1");
        expect(followDeleteMany).toHaveBeenCalledWith({
            where: { subjectType: "service", subjectId: { in: ["s1"] } }
        });

        await follow.forget("task", ["a", "b"]);
        expect(followDeleteMany).toHaveBeenLastCalledWith({
            where: { subjectType: "task", subjectId: { in: ["a", "b"] } }
        });
    });

    it("does nothing for an empty list rather than matching everything", async () => {
        await follow.forget("task", []);
        expect(followDeleteMany).not.toHaveBeenCalled();
    });
});
