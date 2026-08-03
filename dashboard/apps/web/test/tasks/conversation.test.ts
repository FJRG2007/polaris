import { describe, expect, it } from "vitest";
import { mergeConversation } from "@/app/(app)/tasks/conversation";
import type { ActivityView, CommentView } from "@/lib/tasks/task-service";

function comment(overrides: Partial<CommentView> & { id: string; createdAt: string }): CommentView {
    return {
        body: "Looks good",
        parentId: null,
        author: { id: "u1", name: "Ana Ruiz", image: null },
        assignedToId: null,
        resolvedAt: null,
        ...overrides
    };
}

function event(id: string, createdAt: string): ActivityView {
    return { id, action: "status", fromValue: "Open", toValue: "In progress", authorName: "Ana Ruiz", createdAt };
}

describe("mergeConversation", () => {
    it("interleaves comments and history oldest first", () => {
        const stream = mergeConversation(
            [comment({ id: "c1", createdAt: "2026-08-01T10:00:00.000Z" })],
            [event("a1", "2026-08-01T09:00:00.000Z"), event("a2", "2026-08-01T11:00:00.000Z")],
            "all"
        );
        expect(stream.map((item) => (item.kind === "comment" ? item.comment.id : item.line.id))).toEqual([
            "a1",
            "c1",
            "a2"
        ]);
    });

    it("leaves history out when only comments were asked for", () => {
        const stream = mergeConversation(
            [comment({ id: "c1", createdAt: "2026-08-01T10:00:00.000Z" })],
            [event("a1", "2026-08-01T09:00:00.000Z")],
            "comments"
        );
        expect(stream).toHaveLength(1);
        expect(stream[0]?.kind).toBe("comment");
    });

    it("keeps replies out of the stream, since they are drawn under their parent", () => {
        const stream = mergeConversation(
            [
                comment({ id: "c1", createdAt: "2026-08-01T10:00:00.000Z" }),
                comment({ id: "c2", createdAt: "2026-08-01T10:05:00.000Z", parentId: "c1" })
            ],
            [],
            "all"
        );
        expect(stream.map((item) => (item.kind === "comment" ? item.comment.id : item.line.id))).toEqual(["c1"]);
    });
});
