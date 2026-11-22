import { describe, expect, it } from "vitest";
import { conversationFace } from "@/app/(app)/chat/conversation-face";

const viewer = { id: "me", name: "Javier" };
const ana = { id: "ana", name: "Ana" };
const luis = { id: "luis", name: "Luis" };

describe("conversationFace", () => {
    it("draws the conversation with yourself as you", () => {
        expect(conversationFace({ self: true, others: [] }, viewer)).toEqual(viewer);
    });

    it("draws a one-to-one as the person on the other end", () => {
        expect(conversationFace({ others: [ana] }, viewer)).toEqual(ana);
    });

    it("draws a group as a group", () => {
        expect(conversationFace({ others: [ana, luis] }, viewer)).toBeNull();
    });

    it("does not draw a one-to-one whose other side is gone as you", () => {
        expect(conversationFace({ self: false, others: [] }, viewer)).toBeNull();
    });
});
