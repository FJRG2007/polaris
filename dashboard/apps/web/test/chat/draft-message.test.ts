/**
 * The message drawn before the server has seen it.
 *
 * Sending something and having your own name replaced, for half a second, by
 * "Somebody who has left" is what this exists to stop. Nothing failed when it
 * happened - no error, no missing message, nothing in a log. The draft simply
 * left `authorName` null, null is drawn as the sentence for a message whose
 * account is gone, and so every message anybody sent was briefly attributed to a
 * departed stranger on the sender's own screen.
 *
 * That is the shape of every fault this file guards: a field a draft left empty
 * because it did not know the answer yet, where empty already means something
 * specific to whoever draws it.
 */

import { describe, expect, it } from "vitest";
import { draftMessage } from "@/app/(app)/chat/draft-message";

const made = () =>
    draftMessage({
        id: "pending:1",
        channelId: "channel-1",
        authorId: "user-me",
        authorName: "Alex Iglesias",
        body: "on my way"
    });

describe("a message on screen before it has been sent", () => {
    it("is written by the person who wrote it", () => {
        expect(made().authorName).toBe("Alex Iglesias");
        expect(made().authorId).toBe("user-me");
    });

    it("leaves nothing null that is drawn as a sentence about somebody else", () => {
        // The specific trap: `authorName` reads as "Somebody who has left"
        // (message-list.tsx), so a draft that does not fill it is a draft that
        // says something untrue rather than one that says nothing.
        const draft = made();
        expect(draft.authorName).not.toBeNull();
        expect(draft.authorName).not.toBe("");
    });

    it("claims nothing has happened to it yet", () => {
        // A draft that guessed at a receipt would draw a tick the server has not
        // agreed to, which is the one thing a tick may never do.
        const draft = made();
        expect(draft.receipt).toBeNull();
        expect(draft.reactions).toEqual([]);
        expect(draft.replyCount).toBe(0);
        expect(draft.edited).toBe(false);
        expect(draft.deleted).toBe(false);
    });

    it("does not draw a link card the server has not looked at", () => {
        // Settled rather than pending: the real message arrives a moment later
        // and asks. A draft that showed a spinner would show it once per
        // message, for ever, on a card that never came.
        const draft = made();
        expect(draft.preview).toBeNull();
        expect(draft.previewPending).toBe(false);
        expect(draft.references).toEqual([]);
    });

    it("is your own message, so nothing stands between you and it", () => {
        const draft = made();
        expect(draft.blocked).toBe(false);
        expect(draft.forwardable).toBe(true);
    });
});
