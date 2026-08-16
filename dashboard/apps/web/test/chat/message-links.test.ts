/**
 * Where a link to one message lands.
 *
 * The channel list leaves thread replies out - they belong under their root -
 * so walking a channel backwards looking for one can only ever end in "that
 * message is further back than this can reach", however far it walks. A link to
 * a reply is an ordinary thing to be handed, though: a mention inside a thread,
 * a message toast, a report. So the jump asks what the message actually is
 * before it tells anybody it cannot be reached.
 */

import { describe, expect, it } from "vitest";
import { threadRootFor } from "@/app/(app)/chat/links";
import type { ChatMessageView } from "@/lib/chat/messages";

function message(id: string, parentId: string | null): ChatMessageView {
    return {
        id,
        parentId,
        channelId: "c1",
        authorId: "u1",
        authorName: "Ada",
        kind: "text",
        body: id,
        replyCount: 0,
        lastReplyAt: null,
        edited: false,
        deleted: false,
        reactions: [],
        attachments: [],
        quote: null,
        starred: false,
        forwardable: true,
        link: null,
        preview: null,
        previewPending: false,
        receipt: null,
        createdAt: "2026-08-16T00:00:00.000Z"
    };
}

const root = message("root", null);
const reply = message("reply", "root");

describe("a link to a message the channel list does not hold", () => {
    it("opens the thread a reply lives in", () => {
        expect(threadRootFor([root, reply], "reply")).toBe(root);
    });

    it("says nothing to open for a message that stands on its own", () => {
        expect(threadRootFor([root], "root")).toBeNull();
    });

    it("says nothing to open for a message that is not there at all", () => {
        expect(threadRootFor([root, reply], "gone")).toBeNull();
    });

    it("says nothing to open when the root did not come back with it", () => {
        expect(threadRootFor([reply], "reply")).toBeNull();
    });
});
