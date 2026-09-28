/**
 * The discussion every app shares.
 *
 * The same two rules as the history: a comment keeps the id of whoever wrote it
 * with no foreign key, so it survives the account leaving; and nothing cascades
 * from the subject, so `forget` is the only thing that removes a thread.
 *
 * The one worth pinning hardest is the ownership check on editing and deleting.
 * A comment id says nothing about which subject it belongs to, so the guard has
 * to be on the author, and it has to refuse rather than silently do nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const commentCreate = vi.fn(async (_args: unknown) => ({ id: "c1" }));
const commentFindMany = vi.fn(async (_args: unknown) => [] as unknown[]);
const commentUpdate = vi.fn(async (_args: unknown) => ({}));
const commentUpdateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
const commentDeleteMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
const commentCount = vi.fn(async (_args: unknown) => 0);
/** Files sent with a comment. Only a task thread has any, which is what the
 *  reader below checks before asking. */
const attachmentFindMany = vi.fn(async (_args: unknown) => [] as unknown[]);

vi.mock("@polaris/db", () => ({
    prisma: {
        comment: {
            create: commentCreate,
            findMany: commentFindMany,
            update: commentUpdate,
            updateMany: commentUpdateMany,
            deleteMany: commentDeleteMany,
            count: commentCount
        },
        taskAttachment: { findMany: attachmentFindMany }
    }
}));

const comments = await import("../../src/lib/comments/comments");

const TASK = { subjectType: "task", subjectId: "t1" } as const;

const AT = new Date("2026-08-15T10:00:00.000Z");

beforeEach(() => {
    vi.clearAllMocks();
    commentUpdateMany.mockResolvedValue({ count: 1 });
    commentDeleteMany.mockResolvedValue({ count: 1 });
});

describe("posting", () => {
    it("fills in the parts a caller left out", async () => {
        await comments.post("u1", { subjectType: "app", subjectId: "s1", body: "Disk was full" });

        expect(commentCreate).toHaveBeenCalledWith({
            data: {
                subjectType: "app",
                subjectId: "s1",
                parentId: null,
                userId: "u1",
                body: "Disk was full",
                assignedToId: null
            },
            select: { id: true }
        });
    });

    it("accepts nobody as the author, for a note a rule left", async () => {
        await comments.post(null, { subjectType: "task", subjectId: "t1", body: "A rule closed this" });

        const call = commentCreate.mock.calls[0]?.[0] as { data: { userId: string | null } };
        expect(call.data.userId).toBeNull();
    });
});

describe("reading", () => {
    it("returns the thread oldest first with the author attached", async () => {
        commentFindMany.mockResolvedValueOnce([
            {
                id: "c1",
                body: "Restarted it",
                parentId: null,
                assignedToId: null,
                resolvedAt: null,
                createdAt: AT,
                user: { id: "u1", name: "Ana", image: null }
            }
        ]);

        const thread = await comments.thread("app", "s1");

        expect(thread).toEqual([
            {
                id: "c1",
                body: "Restarted it",
                parentId: null,
                assignedToId: null,
                resolvedAt: null,
                createdAt: AT.toISOString(),
                author: { id: "u1", name: "Ana", image: null },
                files: []
            }
        ]);
        // An app's thread carries no files, so it does not pay for the query.
        expect(attachmentFindMany).not.toHaveBeenCalled();
        const call = commentFindMany.mock.calls[0]?.[0] as { orderBy: { createdAt: string } };
        expect(call.orderBy.createdAt).toBe("asc");
    });

    it("keeps a comment whose account is gone", async () => {
        commentFindMany.mockResolvedValueOnce([
            {
                id: "c1",
                body: "Left before you got here",
                parentId: null,
                assignedToId: null,
                resolvedAt: null,
                createdAt: AT,
                user: null
            }
        ]);

        const [only] = await comments.thread("task", "t1");

        expect(only?.body).toBe("Left before you got here");
        expect(only?.author).toBeNull();
    });
});

describe("changing what was said", () => {
    it("only lets the author rewrite it", async () => {
        await comments.edit("u1", "c1", "Better wording");

        expect(commentUpdateMany).toHaveBeenCalledWith({
            where: { id: "c1", userId: "u1" },
            data: { body: "Better wording" }
        });
    });

    it("refuses rather than silently doing nothing when it matched nobody", async () => {
        commentUpdateMany.mockResolvedValueOnce({ count: 0 });

        await expect(comments.edit("u2", "c1", "Not mine")).rejects.toThrow("your own");
    });

    it("narrows a delete to the author unless the caller moderates", async () => {
        await comments.remove("u1", TASK, "c1", false);
        expect(commentDeleteMany).toHaveBeenCalledWith({
            where: { id: "c1", subjectType: "task", subjectId: "t1", userId: "u1" }
        });

        await comments.remove("u1", TASK, "c2", true);
        expect(commentDeleteMany).toHaveBeenLastCalledWith({
            where: { id: "c2", subjectType: "task", subjectId: "t1" }
        });
    });

    it("keeps a moderator's delete to the thread they were cleared for", async () => {
        // Moderating one task's thread is not a licence over every comment on
        // the instance: the subject is always part of the match.
        await comments.remove("u1", { subjectType: "host", subjectId: "h1" }, "c9", true);
        const where = (commentDeleteMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
        expect(where).toMatchObject({ subjectType: "host", subjectId: "h1" });
    });

    it("refuses an id that is not a string before it can become a filter", async () => {
        const filter = { not: "" } as unknown as string;
        await expect(comments.remove("u1", TASK, filter, true)).rejects.toThrow();
        await expect(comments.setResolved("u1", TASK, filter, true)).rejects.toThrow();
        await expect(comments.edit("u1", filter, "x")).rejects.toThrow();
        expect(commentDeleteMany).not.toHaveBeenCalled();
        expect(commentUpdateMany).not.toHaveBeenCalled();
    });

    it("refuses a delete that matched nobody", async () => {
        commentDeleteMany.mockResolvedValueOnce({ count: 0 });

        await expect(comments.remove("u2", TASK, "c1", false)).rejects.toThrow("your own");
    });

    it("records who resolved it, and clears both on reopening", async () => {
        await comments.setResolved("u1", TASK, "c1", true);
        const resolved = commentUpdateMany.mock.calls[0]?.[0] as {
            where: Record<string, unknown>;
            data: { resolvedById: string | null };
        };
        expect(resolved.where).toEqual({ id: "c1", subjectType: "task", subjectId: "t1" });
        expect(resolved.data.resolvedById).toBe("u1");

        await comments.setResolved("u1", TASK, "c1", false);
        const reopened = commentUpdateMany.mock.calls[1]?.[0] as {
            data: { resolvedAt: Date | null; resolvedById: string | null };
        };
        expect(reopened.data.resolvedAt).toBeNull();
        expect(reopened.data.resolvedById).toBeNull();
    });

    it("refuses to resolve a comment from another thread", async () => {
        commentUpdateMany.mockResolvedValueOnce({ count: 0 });

        await expect(comments.setResolved("u1", TASK, "c-elsewhere", true)).rejects.toThrow("not here");
    });
});

describe("forgetting", () => {
    it("takes one subject or a list of them", async () => {
        await comments.forget("app", "s1");
        expect(commentDeleteMany).toHaveBeenCalledWith({
            where: { subjectType: "app", subjectId: { in: ["s1"] } }
        });

        await comments.forget("task", ["a", "b"]);
        expect(commentDeleteMany).toHaveBeenLastCalledWith({
            where: { subjectType: "task", subjectId: { in: ["a", "b"] } }
        });
    });

    it("does nothing for an empty list rather than matching everything", async () => {
        await comments.forget("task", []);
        expect(commentDeleteMany).not.toHaveBeenCalled();
    });
});
