/**
 * A moderator acting on somebody in a call, end to end through the service.
 *
 * Three things have to happen for it to be real rather than a flag on a screen:
 * the seat's row changes (the next ticket is written from it), the media server
 * is told (which is what reaches a browser already connected), and the seat is
 * told (so its owner reads why). And nothing at all may happen when the person
 * pressing has no standing in the conversation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface SeatRow {
    id: string;
    userId: string | null;
    meetingId: string;
    serverMuted: boolean;
    serverDeafened: boolean;
    meeting: {
        endedAt: Date | null;
        channelId: string | null;
        channel: {
            kind: string;
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

/** What the reader's standing in the conversation is. */
let mayModerate = true;

vi.mock("@/lib/chat/access", async (original) => ({
    ...(await original<typeof import("@/lib/chat/access")>()),
    requireChannel: async () => ({ mayModerate })
}));

const applied: unknown[] = [];
let confirmed = true;

vi.mock("@/lib/chat/call-server", () => ({
    applyToSeat: async (meetingId: string, participantId: string, change: unknown) => {
        applied.push({ meetingId, participantId, change });
        return confirmed;
    }
}));

const left: unknown[] = [];

vi.mock("@/lib/chat/meetings", () => ({
    leave: async (seated: unknown) => {
        left.push(seated);
    },
    announceVoiceChange: async () => undefined
}));

const { moderateSeat } = await import("@/lib/chat/call-moderation");
const { subscribeMeetingEvents } = await import("@/lib/chat/meeting-events");

const events: unknown[] = [];
subscribeMeetingEvents((event) => events.push(event));

function seatIn(kind: "voice" | "group", userId: string | null = "member"): SeatRow {
    return {
        id: "seat-1",
        userId,
        meetingId: "m1",
        serverMuted: false,
        serverDeafened: false,
        meeting: {
            endedAt: null,
            channelId: "c1",
            channel: {
                kind,
                ownerId: kind === "group" ? "group-owner" : null,
                createdById: kind === "group" ? "group-owner" : null,
                space: kind === "voice" ? { ownerId: "space-owner" } : null
            }
        }
    };
}

beforeEach(() => {
    seat = seatIn("voice");
    mayModerate = true;
    confirmed = true;
    updates.length = 0;
    applied.length = 0;
    left.length = 0;
    events.length = 0;
});

describe("muting somebody in a voice channel", () => {
    it("stores it, makes the media server enforce it, and tells the seat", async () => {
        const result = await moderateSeat({ id: "admin" }, "seat-1", "mute");

        expect(result.unconfirmed).toBe(false);
        expect(updates).toEqual([{ serverMuted: true, serverDeafened: false }]);
        expect(applied).toEqual([
            {
                meetingId: "m1",
                participantId: "seat-1",
                change: {
                    kind: "restrict",
                    restriction: { serverMuted: true, serverDeafened: false }
                }
            }
        ]);
        expect(events).toContainEqual({
            meetingId: "m1",
            kind: "moderated",
            participantId: "seat-1",
            action: "mute"
        });
    });

    it("undoes only what it was asked to undo", async () => {
        seat = { ...seatIn("voice"), serverMuted: true, serverDeafened: true };
        await moderateSeat({ id: "admin" }, "seat-1", "undeafen");
        expect(updates).toEqual([{ serverMuted: true, serverDeafened: false }]);
    });

    it("says so when the media server did not confirm it", async () => {
        confirmed = false;
        const result = await moderateSeat({ id: "admin" }, "seat-1", "deafen");
        expect(result.unconfirmed).toBe(true);
        // Stored all the same: the next ticket carries it.
        expect(updates).toEqual([{ serverMuted: false, serverDeafened: true }]);
    });
});

describe("who is refused", () => {
    it("refuses somebody with no standing in the conversation, and changes nothing", async () => {
        mayModerate = false;
        await expect(moderateSeat({ id: "member-2" }, "seat-1", "mute")).rejects.toThrow(
            /moderator of this server/
        );
        expect(updates).toHaveLength(0);
        expect(applied).toHaveLength(0);
        expect(events).toHaveLength(0);
    });

    it("protects the space's owner", async () => {
        seat = seatIn("voice", "space-owner");
        await expect(moderateSeat({ id: "admin" }, "seat-1", "mute")).rejects.toThrow(/owner/);
        expect(applied).toHaveLength(0);
    });

    it("refuses a seat that is no longer in the call", async () => {
        seat = null;
        await expect(moderateSeat({ id: "admin" }, "seat-1", "mute")).rejects.toThrow(
            /not in this call/
        );
    });

    it("refuses a meeting that belongs to no conversation", async () => {
        seat = { ...seatIn("voice"), meeting: { ...seatIn("voice").meeting, channelId: null } };
        await expect(moderateSeat({ id: "admin" }, "seat-1", "mute")).rejects.toThrow(/ended/);
    });
});

describe("in a group", () => {
    it("lets whoever runs the group act, and names the group when refusing", async () => {
        seat = seatIn("group");
        await moderateSeat({ id: "group-owner" }, "seat-1", "deafen");
        expect(updates).toEqual([{ serverMuted: false, serverDeafened: true }]);

        mayModerate = false;
        await expect(moderateSeat({ id: "member-2" }, "seat-1", "mute")).rejects.toThrow(
            /runs this group/
        );
    });
});

describe("disconnecting somebody", () => {
    it("tells the seat first, gives the seat up, and closes its connection", async () => {
        const result = await moderateSeat({ id: "admin" }, "seat-1", "disconnect");

        expect(result.unconfirmed).toBe(false);
        expect(events[0]).toEqual({
            meetingId: "m1",
            kind: "moderated",
            participantId: "seat-1",
            action: "disconnect"
        });
        expect(left).toEqual([{ meetingId: "m1", participantId: "seat-1" }]);
        expect(applied).toEqual([
            { meetingId: "m1", participantId: "seat-1", change: { kind: "remove" } }
        ]);
        // Nothing stored about the seat's voice: it is not a mute.
        expect(updates).toHaveLength(0);
    });
});
