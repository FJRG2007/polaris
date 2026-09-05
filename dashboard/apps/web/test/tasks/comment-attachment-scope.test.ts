/**
 * A file sent in a task's thread belongs to that thread and to no other.
 *
 * The upload is authorized on the task, and the comment it was sent with arrives
 * beside it as a separate parameter. Nothing tied the two together: somebody who
 * may write on task A could hand over the id of a comment on task B, and their
 * file would be drawn in that conversation - one they may never have been able
 * to read. The task is what was checked, so the comment is only believed while
 * it belongs to that task.
 *
 * Dropped rather than refused, deliberately. The file itself was legitimately
 * uploaded to the task it names; losing the comment it was written beside is a
 * smaller loss than losing the upload, and the row is still on the task's Files.
 *
 * The reading side is checked too, because a row written before this - or by
 * anything that ever gets this wrong again - must not be drawn in the wrong
 * thread either. One rule in two places, which is what defence in depth is for
 * when the cost is a column in a `where`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const TASK = "11111111-1111-4111-8111-111111111111";
const OTHER_TASK = "22222222-2222-4222-8222-222222222222";
const MINE = "33333333-3333-4333-8333-333333333333";
const THEIRS = "44444444-4444-4444-8444-444444444444";

/** Comments, as the database holds them: which subject each is on. */
const comments = [
    { id: MINE, subjectType: "task", subjectId: TASK },
    { id: THEIRS, subjectType: "task", subjectId: OTHER_TASK }
];

const created = vi.fn();
const attachmentFindMany = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        comment: {
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
                comments.find(
                    (comment) =>
                        comment.id === where.id &&
                        comment.subjectType === where.subjectType &&
                        comment.subjectId === where.subjectId
                ) ?? null,
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                comments
                    .filter(
                        (comment) =>
                            comment.subjectType === where.subjectType && comment.subjectId === where.subjectId
                    )
                    .map((comment) => ({
                        ...comment,
                        userId: "ada",
                        body: "here it is",
                        parentId: null,
                        assignedToId: null,
                        resolvedAt: null,
                        createdAt: new Date(),
                        user: { id: "ada", name: "Ada" }
                    }))
        },
        taskAttachment: {
            create: async (args: { data: Record<string, unknown> }) => {
                created(args.data);
                return {
                    id: "file-1",
                    name: args.data.name,
                    mime: args.data.mime,
                    size: 1,
                    uploadedById: args.data.uploadedById,
                    createdAt: new Date()
                };
            },
            findMany: attachmentFindMany
        }
    }
}));

/** Somewhere for the bytes to go that is not a disk. Where a file lands is not
 *  what these cases are about. */
vi.mock("@/lib/storage-target", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveStorageTarget: async () => "local",
    storageTargetOptions: async () => [],
    LOCAL_TARGET: "local",
    openForWriting: async () => ({
        targetId: "local",
        driver: {
            mkdir: async () => undefined,
            writeStream: async () => ({ size: 1n }),
            dispose: async () => undefined
        }
    })
}));

const { storeAttachment } = await import("../../src/lib/tasks/attachment-service");
const { thread } = await import("../../src/lib/comments/comments");

function upload(commentId: string | null) {
    return storeAttachment({
        taskId: TASK,
        uploadedById: "ada",
        name: "screenshot.png",
        mime: "image/png",
        size: 1,
        body: new ReadableStream<Uint8Array>({
            start(controller) {
                controller.close();
            }
        }),
        commentId
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    attachmentFindMany.mockResolvedValue([]);
});

describe("the comment a file says it was sent with", () => {
    it("is kept when it is a comment on that task", async () => {
        await upload(MINE);
        expect(created).toHaveBeenCalledWith(expect.objectContaining({ taskId: TASK, commentId: MINE }));
    });

    it("is dropped when it belongs to another task", async () => {
        // The file is still uploaded, and still on this task's Files. What it
        // does not do is appear in a conversation on a task the uploader was
        // never authorized against.
        await upload(THEIRS);
        expect(created).toHaveBeenCalledWith(expect.objectContaining({ taskId: TASK, commentId: null }));
    });

    it("is dropped when it is not a comment at all", async () => {
        await upload("55555555-5555-4555-8555-555555555555");
        expect(created).toHaveBeenCalledWith(expect.objectContaining({ commentId: null }));
    });

    it("costs no lookup when there is none", async () => {
        await upload(null);
        expect(created).toHaveBeenCalledWith(expect.objectContaining({ commentId: null }));
    });
});

describe("what a thread draws", () => {
    it("asks for files on this task as well as on these comments", async () => {
        // The pair is what says a file belongs here. On the comment alone, a row
        // written against another task's comment would be drawn in this thread,
        // however it came to exist.
        await thread("task", TASK);
        expect(attachmentFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ taskId: TASK, commentId: { in: [MINE] } })
            })
        );
    });

    it("pays for no query on a subject that has no files in its thread", async () => {
        await thread("host", TASK);
        expect(attachmentFindMany).not.toHaveBeenCalled();
    });
});
