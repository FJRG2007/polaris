/**
 * "Mark as read" on a message's notice.
 *
 * The same request whoever hears the press - the card, the desktop app, or a
 * browser's service worker with no tab open - so the route is what is pinned:
 * the conversation is read up to the message, for the caller only; anything
 * but a JSON body naming a message is refused, which keeps another site from
 * marking somebody's conversations read; and a conversation they are not in is
 * a refusal, not a fault.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CHANNEL = "11111111-1111-4111-8111-111111111111";
const MESSAGE = "22222222-2222-4222-8222-222222222222";

const fake = vi.hoisted(() => ({
    read: [] as string[],
    signedIn: true,
    refuse: null as string | null
}));

vi.mock("@/lib/api-session", () => ({
    apiPermission: async () =>
        fake.signedIn
            ? { id: "ana", name: "Ana" }
            : Response.json({ error: "Unauthorized" }, { status: 401 })
}));
vi.mock("@/lib/chat/messages", async () => {
    const { ChatAccessError } = await import("@/lib/chat/access");
    return {
        markRead: async (
            actor: { id: string },
            input: { channelId: string; messageId: string }
        ) => {
            if (fake.refuse) throw new ChatAccessError(fake.refuse);
            fake.read.push(`${actor.id} ${input.channelId} ${input.messageId}`);
        }
    };
});

const { POST } = await import("@/app/api/chat/channels/[channelId]/read/route");

function press(body: unknown, type = "application/json", channelId = CHANNEL) {
    return POST(
        new Request(`http://polaris.test/api/chat/channels/${channelId}/read`, {
            method: "POST",
            headers: { "content-type": type },
            body: typeof body === "string" ? body : JSON.stringify(body)
        }),
        { params: Promise.resolve({ channelId }) }
    );
}

beforeEach(() => {
    fake.read = [];
    fake.signedIn = true;
    fake.refuse = null;
});

describe("marking a conversation read from its notice", () => {
    it("reads it up to the message, for whoever pressed", async () => {
        const answer = await press({ messageId: MESSAGE });
        expect(answer.status).toBe(204);
        expect(fake.read).toEqual([`ana ${CHANNEL} ${MESSAGE}`]);
    });

    it("takes only JSON, so a form from another site cannot do it", async () => {
        expect(
            (await press(`messageId=${MESSAGE}`, "application/x-www-form-urlencoded")).status
        ).toBe(415);
        expect(fake.read).toEqual([]);
    });

    it("refuses something that is not a message in a conversation", async () => {
        expect((await press({ messageId: "nope" })).status).toBe(400);
        expect((await press({ messageId: MESSAGE }, "application/json", "nope")).status).toBe(400);
        expect((await press("{not json")).status).toBe(400);
        expect(fake.read).toEqual([]);
    });

    it("says no for a conversation they are not in, and nothing for somebody signed out", async () => {
        fake.refuse = "You are not in this conversation";
        expect((await press({ messageId: MESSAGE })).status).toBe(403);
        fake.signedIn = false;
        expect((await press({ messageId: MESSAGE })).status).toBe(401);
        expect(fake.read).toEqual([]);
    });
});
