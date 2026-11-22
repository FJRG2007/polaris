/**
 * Stage channels, server side: who starts in the audience, what the media
 * server is told an audience seat may do, and a moderator moving somebody
 * between the speakers and the audience.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface SeatRow {
    id: string;
    userId: string | null;
    meetingId: string;
    serverMuted: boolean;
    serverDeafened: boolean;
    audience: boolean;
    meeting: {
        endedAt: Date | null;
        channelId: string | null;
        channel: {
            kind: string;
            stage: boolean;
            ownerId: string | null;
            createdById: string | null;
            space: { ownerId: string } | null;
        } | null;
    };
}

let seat: SeatRow | null = null;
const updates: unknown[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        meetingParticipant: {
            findFirst: async () => seat,
            update: async (input: { data: Record<string, unknown> }) => {
                updates.push(input.data);
                if (seat) Object.assign(seat, input.data);
                return seat;
            }
        }
    }
}));

vi.mock("@/lib/chat/access", async (original) => ({
    ...(await original<typeof import("@/lib/chat/access")>()),
    requireChannel: async () => ({ mayModerate: true })
}));

const applied: unknown[] = [];

vi.mock("@/lib/chat/call-server", () => ({
    applyToSeat: async (_meetingId: string, _participantId: string, change: unknown) => {
        applied.push(change);
        return true;
    }
}));

vi.mock("@/lib/chat/meetings", async (original) => ({
    ...(await original<typeof import("@/lib/chat/meetings")>()),
    leave: async () => undefined,
    announceVoiceChange: async () => undefined
}));

const { moderateSeat } = await import("@/lib/chat/call-moderation");
const { seatStartsInAudience } = await import("@/lib/chat/meetings");
const { mediaPermissions, microphoneAllowed, restrictionAfter, heldBack, UNRESTRICTED } =
    await import("@/lib/chat/voice-moderation");

const SPACE_ID = "0190a0a0-0000-7000-8000-000000000001";

function seatOn(stage: boolean, audience: boolean): SeatRow {
    return {
        id: "seat-1",
        userId: "member",
        meetingId: "m1",
        serverMuted: false,
        serverDeafened: false,
        audience,
        meeting: {
            endedAt: null,
            channelId: "c1",
            channel: {
                kind: "voice",
                stage,
                ownerId: null,
                createdById: null,
                space: { ownerId: "space-owner" }
            }
        }
    };
}

beforeEach(() => {
    seat = seatOn(true, true);
    updates.length = 0;
    applied.length = 0;
});

describe("creating a stage", () => {
    it("is a voice channel with the stage flag", () => {
        const parsed = core.chatChannelCreateSchema.safeParse({
            spaceId: SPACE_ID,
            name: "town-hall",
            kind: "voice",
            stage: true
        });
        expect(parsed.success).toBe(true);
    });

    it("refuses the flag on anything but a voice channel", () => {
        const parsed = core.chatChannelCreateSchema.safeParse({
            spaceId: SPACE_ID,
            name: "town-hall",
            kind: "text",
            stage: true
        });
        expect(parsed.success).toBe(false);
    });
});

describe("where a new seat starts", () => {
    it("starts in the audience on a stage", () => {
        expect(seatStartsInAudience({ kind: "voice", stage: true }, false)).toBe(true);
    });

    it("starts among the speakers for somebody who may moderate", () => {
        expect(seatStartsInAudience({ kind: "voice", stage: true }, true)).toBe(false);
    });

    it("never starts in an audience off a stage", () => {
        expect(seatStartsInAudience({ kind: "voice", stage: false }, false)).toBe(false);
        expect(seatStartsInAudience({ kind: "group", stage: true }, false)).toBe(false);
        expect(seatStartsInAudience(null, false)).toBe(false);
    });
});

describe("what an audience seat may do", () => {
    it("publishes nothing and still receives everything", () => {
        const permissions = mediaPermissions({ ...UNRESTRICTED, audience: true });
        expect(permissions.canPublish).toBe(false);
        expect(permissions.canSubscribe).toBe(true);
        expect(microphoneAllowed(permissions)).toBe(false);
    });

    it("gets everything back once invited to speak", () => {
        const speaker = restrictionAfter({ ...UNRESTRICTED, audience: true }, "invite-to-speak");
        expect(speaker.audience).toBe(false);
        expect(mediaPermissions(speaker).canPublish).toBe(true);
        expect(microphoneAllowed(mediaPermissions(speaker))).toBe(true);
    });

    it("keeps a moderator's mute through an invitation", () => {
        const invited = restrictionAfter(
            { serverMuted: true, serverDeafened: false, audience: true },
            "invite-to-speak"
        );
        expect(invited.serverMuted).toBe(true);
        expect(microphoneAllowed(mediaPermissions(invited))).toBe(false);
    });

    it("explains a press of the microphone in the audience", () => {
        expect(heldBack({ ...UNRESTRICTED, audience: true })).toBe(
            "moderation.notice.move-to-audience"
        );
    });
});

describe("moving somebody on a stage", () => {
    it("invites an audience seat to speak and tells the media server", async () => {
        await moderateSeat({ id: "admin" }, "seat-1", "invite-to-speak");
        expect(updates).toEqual([{ serverMuted: false, serverDeafened: false, audience: false }]);
        expect(applied).toEqual([
            {
                kind: "restrict",
                restriction: { serverMuted: false, serverDeafened: false, audience: false }
            }
        ]);
    });

    it("moves a speaker back to the audience", async () => {
        seat = seatOn(true, false);
        await moderateSeat({ id: "admin" }, "seat-1", "move-to-audience");
        expect(updates).toEqual([{ serverMuted: false, serverDeafened: false, audience: true }]);
    });

    it("refuses both off a stage, changing nothing", async () => {
        seat = seatOn(false, false);
        await expect(moderateSeat({ id: "admin" }, "seat-1", "move-to-audience")).rejects.toThrow();
        await expect(moderateSeat({ id: "admin" }, "seat-1", "invite-to-speak")).rejects.toThrow();
        expect(updates).toEqual([]);
        expect(applied).toEqual([]);
    });
});
