/**
 * The chat screen's timed reads, as routes.
 *
 * Pinned here is what the screen relies on and what keeps the routes from
 * answering more than the reader may see: only rooms and conversations the
 * reader can reach are answered, a signed-out request is refused, and the body
 * has the shape `fetchVoicePresence` and `fetchLiveCall` read.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ROOM_A = "019f8506-683f-7dd0-9c13-1e9ee9237fe3";
const ROOM_B = "019f8506-683f-7dd0-9c13-1e9ee9237fe4";
const FOREIGN = "019f8506-683f-7dd0-9c13-1e9ee9237fe5";
const PERSON = { userId: "u2", name: "Grace" };

class ChatAccessError extends Error {}

const backgroundUser = vi.fn(async () => ({ id: "u1", name: "Ada" }) as { id: string } | null);
const sessionCan = vi.fn(async () => true);
const reachableChannelIds = vi.fn(async () => new Set([ROOM_A, ROOM_B]));
const requireChannel = vi.fn(async (_actor: unknown, channelId: string) => {
    if (channelId === FOREIGN) throw new ChatAccessError();
    return {};
});
const voicePresence = vi.fn(
    async (ids: readonly string[]) => new Map(ids.map((id) => [id, [PERSON]]))
);
const liveIn = vi.fn(async () => ({ id: "m1", count: 1, people: [PERSON], extra: "x" }) as unknown);

vi.mock("@/lib/session", () => ({ backgroundUser, sessionCan }));
vi.mock("@/lib/chat/access", () => ({ ChatAccessError, reachableChannelIds, requireChannel }));
vi.mock("@/lib/chat/meetings", () => ({ voicePresence, liveIn }));

const presence = await import("../../src/app/api/chat/voice-presence/route");
const liveCall = await import("../../src/app/api/chat/channels/[channelId]/live-call/route");

const presenceRequest = (ids: readonly string[]) =>
    new Request(`https://polaris.example/api/chat/voice-presence?ids=${ids.join(",")}`);
const callParams = (channelId: string) => ({ params: Promise.resolve({ channelId }) });
const callRequest = () => new Request("https://polaris.example/x");

beforeEach(() => vi.clearAllMocks());

describe("who is in the voice rooms", () => {
    it("answers each reachable room in the shape the rail reads", async () => {
        const response = await presence.GET(presenceRequest([ROOM_A, ROOM_B]));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            inRoom: { [ROOM_A]: [PERSON], [ROOM_B]: [PERSON] }
        });
    });

    it("leaves out a room the reader cannot reach", async () => {
        const response = await presence.GET(presenceRequest([ROOM_A, FOREIGN]));
        expect(voicePresence).toHaveBeenCalledWith([ROOM_A]);
        expect(await response.json()).toEqual({ inRoom: { [ROOM_A]: [PERSON] } });
    });

    it("refuses a signed-out request", async () => {
        backgroundUser.mockResolvedValueOnce(null);
        const response = await presence.GET(presenceRequest([ROOM_A]));
        expect(response.status).toBe(401);
        expect(voicePresence).not.toHaveBeenCalled();
    });

    it("answers nothing to a reader without chat", async () => {
        sessionCan.mockResolvedValueOnce(false);
        const response = await presence.GET(presenceRequest([ROOM_A]));
        expect(await response.json()).toEqual({ inRoom: {} });
        expect(voicePresence).not.toHaveBeenCalled();
    });

    it("refuses what is not a room id", async () => {
        const response = await presence.GET(presenceRequest([ROOM_A, "../../admin"]));
        expect(response.status).toBe(400);
        expect(voicePresence).not.toHaveBeenCalled();
    });

    it("answers an empty list with no rooms", async () => {
        const response = await presence.GET(presenceRequest([]));
        expect(await response.json()).toEqual({ inRoom: {} });
    });

    it("answers the first rooms of a very long list instead of refusing it", async () => {
        const many = Array.from({ length: 250 }, () => ROOM_A);
        const response = await presence.GET(presenceRequest(many));
        expect(response.status).toBe(200);
        expect(voicePresence.mock.calls[0]?.[0]).toHaveLength(200);
    });
});

describe("the call in a conversation", () => {
    it("answers the live call in the shape the banner reads", async () => {
        const response = await liveCall.GET(callRequest(), callParams(ROOM_A));
        expect(response.status).toBe(200);
        expect(requireChannel).toHaveBeenCalledWith({ id: "u1" }, ROOM_A);
        expect(await response.json()).toEqual({
            live: { meetingId: "m1", count: 1, people: [PERSON] }
        });
    });

    it("answers no call when none is running", async () => {
        liveIn.mockResolvedValueOnce(null);
        const response = await liveCall.GET(callRequest(), callParams(ROOM_A));
        expect(await response.json()).toEqual({ live: null });
    });

    it("answers no call for a conversation the reader is not in", async () => {
        const response = await liveCall.GET(callRequest(), callParams(FOREIGN));
        expect(await response.json()).toEqual({ live: null });
        expect(liveIn).not.toHaveBeenCalled();
    });

    it("refuses a signed-out request", async () => {
        backgroundUser.mockResolvedValueOnce(null);
        const response = await liveCall.GET(callRequest(), callParams(ROOM_A));
        expect(response.status).toBe(401);
        expect(liveIn).not.toHaveBeenCalled();
    });

    it("does not look up what is not a conversation id", async () => {
        const response = await liveCall.GET(callRequest(), callParams("../../admin"));
        expect(await response.json()).toEqual({ live: null });
        expect(requireChannel).not.toHaveBeenCalled();
    });

    it("answers no call to a reader without chat", async () => {
        sessionCan.mockResolvedValueOnce(false);
        const response = await liveCall.GET(callRequest(), callParams(ROOM_A));
        expect(await response.json()).toEqual({ live: null });
        expect(requireChannel).not.toHaveBeenCalled();
    });
});
