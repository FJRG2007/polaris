/**
 * The server side of a deck's call keys: one question about the call a deck
 * asks once however many keys ask it together, and a sound picker that lists
 * every space rather than the first few.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const findUnique = vi.fn();
const queryRaw = vi.fn();
const reachableSpaceIds = vi.fn(async () => new Set(["s1", "s2"]));

vi.mock("@polaris/db", () => ({
    prisma: {
        meetingParticipant: { findFirst, findUnique },
        chatChannel: { findUnique: async () => ({ kind: "dm" }) },
        $queryRaw: queryRaw
    }
}));
vi.mock("@/lib/chat/access", () => ({ reachableSpaceIds }));
vi.mock("@/lib/chat/soundboard-service", () => ({ playSound: async () => null }));
vi.mock("@/lib/chat/meeting-events", () => ({ publishMeetingEvent: () => undefined }));

const service = await import("../../src/lib/chat/call-remote-service");

const ROW = {
    id: "p1",
    meetingId: "m1",
    muted: false,
    deafened: false,
    meeting: { hostId: "u1", channelId: "c1" }
};

beforeEach(() => vi.clearAllMocks());

describe("liveCallOf", () => {
    it("asks the database once for every key read at the same moment", async () => {
        findFirst.mockResolvedValue(ROW);
        const answers = await Promise.all([
            service.liveCallOf("u1"),
            service.liveCallOf("u1"),
            service.liveCallOf("u1")
        ]);

        expect(findFirst).toHaveBeenCalledTimes(1);
        expect(answers.every((answer) => answer?.seat.participantId === "p1")).toBe(true);
    });

    it("asks again on the next read, so a key never shows an old call", async () => {
        findFirst.mockResolvedValueOnce(ROW).mockResolvedValueOnce(null);

        expect(await service.liveCallOf("u1")).not.toBeNull();
        expect(await service.liveCallOf("u1")).toBeNull();
        expect(findFirst).toHaveBeenCalledTimes(2);
    });

    it("asks again after a lookup that failed", async () => {
        findFirst.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(ROW);

        await expect(service.liveCallOf("u1")).rejects.toThrow("down");
        expect(await service.liveCallOf("u1")).not.toBeNull();
    });
});

describe("what undeafening gives back", () => {
    it("is the microphone as it was when the seat deafened, once that was seen", async () => {
        findUnique.mockResolvedValue({ userId: "u9" });
        const deafened = { ...ROW, id: "p9", muted: true, deafened: true };
        findFirst.mockResolvedValue(deafened);
        // Never seen deafening: not known.
        await service.noteControls("p9", { muted: true, deafened: true });
        expect((await service.liveCallOf("u9"))?.mutedBeforeDeafen).toBeUndefined();
        // Heard, then deafened: it comes back heard.
        await service.noteControls("p9", { muted: false, deafened: false });
        await service.noteControls("p9", { muted: true, deafened: true });
        expect((await service.liveCallOf("u9"))?.mutedBeforeDeafen).toBe(false);
        // Undeafened: forgotten, and not reported for a seat that is not deafened.
        await service.noteControls("p9", { muted: false, deafened: false });
        findFirst.mockResolvedValue({ ...deafened, muted: false, deafened: false });
        expect((await service.liveCallOf("u9"))?.mutedBeforeDeafen).toBeUndefined();
    });
});

describe("deckSounds", () => {
    it("lists the spaces' sounds a space at a time, after Polaris's own", async () => {
        queryRaw.mockResolvedValue([
            { id: "a1", name: "Horn", emoji: "", spaceName: "Alpha", turn: 1n },
            { id: "b1", name: "Bell", emoji: "", spaceName: "Beta", turn: 1n },
            { id: "a2", name: "Drum", emoji: "", spaceName: "Alpha", turn: 2n }
        ]);
        const sounds = await service.deckSounds("u1", (id) => id);
        const theirs = sounds.filter((sound) => !sound.value.includes(":"));

        expect(theirs.map((sound) => sound.value)).toEqual(["a1", "a2", "b1"]);
        expect(theirs[0]?.label).toBe("Horn (Alpha)");
    });

    it("takes the spaces' sounds in turns, so no space is crowded out", async () => {
        queryRaw.mockResolvedValue([]);
        await service.deckSounds("u1", (id) => id);
        const sql = (queryRaw.mock.calls[0]?.[0] as readonly string[]).join("?");

        expect(sql).toMatch(/ROW_NUMBER\(\) OVER \(PARTITION BY s\."spaceId"/);
        expect(sql).toMatch(/ORDER BY "turn"/);
    });

    it("asks nothing of the database for somebody in no space", async () => {
        reachableSpaceIds.mockResolvedValueOnce(new Set());
        await service.deckSounds("u1", (id) => id);

        expect(queryRaw).not.toHaveBeenCalled();
    });
});
