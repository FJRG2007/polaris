/**
 * Who the members column says is in voice, worked out from the rooms the rail
 * already asks about.
 *
 * Only rooms of the space being looked at that the reader can see count: a seat
 * reported for any other room - another space, an archived room, one the reader
 * has no row for - is never named beside a face.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/chat/actions", () => ({ voicePresenceAction: async () => ({ inRoom: {} }) }));
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({ useChatStream: () => undefined }));

const { spaceVoiceIds, voiceSeats } = await import("@/app/(app)/chat/voice-rooms");

const room = (id: string, spaceId: string | null, kind = "voice", archived = false) =>
    ({ id, name: `room-${id}`, spaceId, kind, archived }) as never;

const seat = (userId: string | null) =>
    ({
        id: `seat-${userId}`,
        name: `Seat ${userId}`,
        userId,
        muted: false,
        deafened: false,
        streaming: false,
        serverMuted: false,
        serverDeafened: false
    }) as never;

const channels = [
    room("v1", "s1"),
    room("t1", "s1", "text"),
    room("v2", "s1"),
    room("old", "s1", "voice", true),
    room("elsewhere", "s2")
];

describe("the voice rooms of a space", () => {
    it("are its unarchived voice channels, and nothing without a space", () => {
        expect(spaceVoiceIds(channels, "s1")).toEqual(["v1", "v2"]);
        expect(spaceVoiceIds(channels, null)).toEqual([]);
    });
});

describe("who is in voice", () => {
    it("names the room each account sits in", () => {
        const found = voiceSeats(channels, "s1", { v1: [seat("user-1")], v2: [seat("user-2")] });
        expect(found.get("user-1")).toEqual({ channelId: "v1", channelName: "room-v1" });
        expect(found.get("user-2")).toEqual({ channelId: "v2", channelName: "room-v2" });
    });

    it("ignores rooms the reader cannot see, other spaces and archived rooms", () => {
        const found = voiceSeats(channels, "s1", {
            hidden: [seat("user-1")],
            elsewhere: [seat("user-2")],
            old: [seat("user-3")],
            t1: [seat("user-4")]
        });
        expect(found.size).toBe(0);
    });

    it("skips seats with no account and keeps the first room for somebody in two", () => {
        const found = voiceSeats(channels, "s1", {
            v1: [seat(null), seat("user-1")],
            v2: [seat("user-1")]
        });
        expect([...found.keys()]).toEqual(["user-1"]);
        expect(found.get("user-1")?.channelId).toBe("v1");
    });

    it("is nobody outside a space", () => {
        expect(voiceSeats(channels, null, { v1: [seat("user-1")] }).size).toBe(0);
    });
});
