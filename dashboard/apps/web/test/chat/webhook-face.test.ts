import { describe, expect, it } from "vitest";
import { webhookFace } from "@/lib/chat/webhook-face";

const HOOK = "0190a000-0000-7000-8000-000000000001";
const MESSAGE = "0190a000-0000-7000-8000-000000000002";

describe("the picture a webhook message is drawn with", () => {
    it("is the one the request asked for, served back through Polaris", () => {
        const face = webhookFace(
            { id: MESSAGE, webhookId: HOOK, authorAvatarUrl: "https://cdn.example/a.png" },
            new Map([[HOOK, new Date(5)]])
        );
        expect(face).toBe(`/api/chat/webhook-avatar/${MESSAGE}`);
        expect(face).not.toContain("cdn.example");
    });

    it("is the webhook's own picture otherwise, versioned by when it changed", () => {
        expect(webhookFace({ id: MESSAGE, webhookId: HOOK }, new Map([[HOOK, new Date(5)]]))).toBe(
            `/api/avatar/chat/webhook/${HOOK}?v=5`
        );
    });

    it("is none for a webhook without a picture, or a message from a person", () => {
        expect(webhookFace({ id: MESSAGE, webhookId: HOOK }, new Map())).toBeNull();
        expect(
            webhookFace({ id: MESSAGE, webhookId: null, authorAvatarUrl: "https://x.example/a.png" }, new Map())
        ).toBeNull();
    });
});
