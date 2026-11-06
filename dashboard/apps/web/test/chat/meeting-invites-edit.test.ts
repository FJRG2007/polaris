/**
 * Changing a standing meeting's invitations from its own page.
 *
 * **Who may.** Only the host: a non-host is refused by the server for every
 * change, and nothing is written or sent.
 *
 * **Adding** convenes people the same way creating does - one bell alert each -
 * and somebody already asked is neither stored twice nor alerted twice.
 *
 * **Removing** takes the meeting's page away from them: by id they are refused,
 * while the link (the credential the host can shut separately) still leads to the
 * door, and a seat they already hold is left alone.
 *
 * **The code.** A new code replaces the old in one write, so the old one names
 * nothing from that moment; removing it does the same with no replacement.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface MeetingRow {
    id: string;
    hostId: string;
    title: string;
    channelId: null;
    endedAt: Date | null;
    approveGuests: boolean;
    requireAccount: boolean;
    guestToken: string | null;
    joinCode: string | null;
}
interface Seat {
    id: string;
    meetingId: string;
    userId: string;
    admission: string;
    leftAt: Date | null;
}

const HOST = "0190a1b2-0000-7000-8000-000000000001";
const BOB = "0190a1b2-0000-7000-8000-000000000002";
const EVE = "0190a1b2-0000-7000-8000-000000000003";
const MEETING = "0190a1b2-0000-7000-8000-0000000000aa";

let meeting: MeetingRow;
let invites: { meetingId: string; userId: string }[] = [];
let emails: { meetingId: string; email: string }[] = [];
let seats: Seat[] = [];
let notified: { userId: string; type: string; href: string }[] = [];
let viewer = HOST;

vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));
vi.mock("@/lib/blocks", () => ({ blockersOf: async () => new Set<string>() }));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => null,
    getIntegrationSecret: async () => null
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/meeting-events", () => ({ publishMeetingEvent: () => undefined }));
vi.mock("@/lib/i18n/request", () => ({
    getTranslations: async () => (key: string) => key,
    getLocale: async () => "en-US"
}));
vi.mock("@/lib/i18n/translate", async (original) => ({
    ...(await original<typeof import("@/lib/i18n/translate")>()),
    translatorFor: () => (key: string) => key
}));
vi.mock("@/lib/i18n/locale-service", () => ({ getUserLocale: async () => "en-US" }));
vi.mock("@/lib/session", () => ({
    requirePermission: async () => ({ id: viewer, name: viewer === HOST ? "Host" : "Eve" })
}));
vi.mock("@polaris/auth", () => ({ can: async () => true }));
vi.mock("@/lib/chat/call-server", () => ({ callsUnavailable: async () => null }));
vi.mock("@/lib/notification-service", () => ({
    createNotification: async (note: { userId: string; type: string; href: string }) => {
        notified.push({ userId: note.userId, type: note.type, href: note.href });
    }
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: () => undefined }) }));
vi.mock("@/lib/chat/chat-service", () => ({}));
vi.mock("@/lib/chat/meeting-link-access", () => ({}));
vi.mock("@/lib/link-denial", () => ({}));
vi.mock("@/lib/backup-access/service", () => ({}));
vi.mock("@/lib/privacy-service", () => ({}));
vi.mock("@/lib/presence-service", () => ({}));
vi.mock("@/lib/chat/call-moderation", () => ({}));
vi.mock("@/lib/chat/declined-calls", () => ({}));

type Where = Record<string, unknown>;
const matchSeat = (seat: Seat, where: Where): boolean =>
    (where.meetingId === undefined || seat.meetingId === where.meetingId) &&
    (where.userId === undefined || seat.userId === where.userId) &&
    (where.admission === undefined || seat.admission === where.admission) &&
    (!("leftAt" in where) || (where.leftAt === null ? seat.leftAt === null : true));

/** What the meeting module asks the database, answered from the arrays above.
 *  Anything this suite does not care about answers empty. */
const handled: Record<string, Record<string, (args: never) => unknown>> = {
    user: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
            where.id.in.map((id) => ({ id }))
    },
    meeting: {
        findUnique: async ({
            where
        }: {
            where: { id?: string; joinCode?: string; guestToken?: string };
        }) => {
            if (where.joinCode !== undefined)
                return meeting.joinCode === where.joinCode ? meeting : null;
            if (where.guestToken !== undefined)
                return meeting.guestToken === where.guestToken ? meeting : null;
            if (where.id !== meeting.id) return null;
            return {
                ...meeting,
                invites: invites
                    .filter((row) => row.meetingId === meeting.id)
                    .map((row) => ({ id: row.userId, userId: row.userId })),
                channel: null
            };
        },
        update: async ({ data }: { data: Partial<MeetingRow> }) => {
            Object.assign(meeting, data);
            return meeting;
        }
    },
    meetingInvite: {
        findMany: async ({ where }: { where: { meetingId: string; userId: { in: string[] } } }) =>
            invites.filter(
                (row) => row.meetingId === where.meetingId && where.userId.in.includes(row.userId)
            ),
        createMany: async ({ data }: { data: { meetingId: string; userId: string }[] }) => {
            for (const row of data) {
                if (!invites.some((r) => r.meetingId === row.meetingId && r.userId === row.userId))
                    invites.push({ meetingId: row.meetingId, userId: row.userId });
            }
            return { count: data.length };
        },
        deleteMany: async ({ where }: { where: { meetingId: string; userId: string } }) => {
            invites = invites.filter(
                (row) => !(row.meetingId === where.meetingId && row.userId === where.userId)
            );
            return { count: 1 };
        }
    },
    meetingEmailInvite: {
        count: async () => emails.length,
        findMany: async ({ where }: { where: { email: { in: string[] } } }) =>
            emails.filter((row) => where.email.in.includes(row.email)),
        createMany: async ({ data }: { data: { meetingId: string; email: string }[] }) => {
            emails.push(...data.map((row) => ({ meetingId: row.meetingId, email: row.email })));
            return { count: data.length };
        },
        deleteMany: async ({ where }: { where: { email: string } }) => {
            emails = emails.filter((row) => row.email !== where.email);
            return { count: 1 };
        }
    },
    meetingParticipant: {
        findFirst: async ({ where }: { where: Where }) =>
            seats.find((seat) => matchSeat(seat, where)) ?? null,
        create: async ({
            data
        }: {
            data: { meetingId: string; userId: string; admission: string };
        }) => {
            const seat = { id: `s${seats.length + 1}`, leftAt: null, ...data };
            seats.push(seat);
            return { id: seat.id };
        },
        update: async () => ({})
    }
};

const empty = (method: string): unknown => {
    if (method === "findMany") return [];
    if (method === "count") return 0;
    if (method.endsWith("Many")) return { count: 0 };
    return null;
};

vi.mock("@polaris/db", () => {
    const model = (name: string) =>
        new Proxy(
            {},
            {
                get: (_target, method: string) =>
                    handled[name]?.[method] ?? (async () => empty(method))
            }
        );
    const prisma = new Proxy(
        {
            $transaction: async (ops: unknown) =>
                Array.isArray(ops) ? Promise.all(ops) : (ops as (tx: unknown) => unknown)(prisma)
        } as Record<string, unknown>,
        { get: (target, name: string) => target[name] ?? model(name) }
    );
    return { prisma };
});

const meetings = await import("@/lib/chat/meetings");
const actions = await import("@/app/(app)/chat/meeting-actions");

beforeEach(() => {
    meeting = {
        id: MEETING,
        hostId: HOST,
        title: "Planning",
        channelId: null,
        endedAt: null,
        approveGuests: true,
        requireAccount: false,
        guestToken: "token-1",
        joinCode: "ABCDEFGHJ"
    };
    invites = [];
    emails = [];
    seats = [];
    notified = [];
    viewer = HOST;
});

describe("who may change the invitations", () => {
    it("refuses everybody but the host, and writes and sends nothing", async () => {
        viewer = EVE;
        expect(await actions.inviteToMeetingAction({ meetingId: MEETING, userIds: [BOB] })).toEqual(
            {
                error: "Only whoever is hosting the meeting can do that"
            }
        );
        expect(invites).toHaveLength(0);
        expect(notified).toHaveLength(0);

        invites.push({ meetingId: MEETING, userId: BOB });
        expect((await actions.uninviteFromMeetingAction(MEETING, BOB)).error).toBeTruthy();
        expect(invites).toHaveLength(1);

        expect(
            (await actions.setJoinCodeAction({ meetingId: MEETING, on: true })).error
        ).toBeTruthy();
        expect(meeting.joinCode).toBe("ABCDEFGHJ");

        emails.push({ meetingId: MEETING, email: "a@b.io" });
        expect(
            (await actions.uninviteEmailFromMeetingAction({ meetingId: MEETING, email: "a@b.io" }))
                .error
        ).toBeTruthy();
        expect(emails).toHaveLength(1);
    });

    it("validates what it is sent before anything else", async () => {
        expect((await actions.uninviteFromMeetingAction("nope", BOB)).error).toBe(
            "errors.didNotWork"
        );
        expect((await actions.setJoinCodeAction({ meetingId: MEETING, on: "yes" })).error).toBe(
            "errors.didNotWork"
        );
        expect(
            (await actions.inviteToMeetingAction({ meetingId: MEETING, userIds: [], emails: [] }))
                .error
        ).toBe("errors.pickToInvite");
    });
});

describe("adding people", () => {
    it("alerts each new person once, the way creating a meeting does", async () => {
        expect(await actions.inviteToMeetingAction({ meetingId: MEETING, userIds: [BOB] })).toEqual(
            {
                invited: 1
            }
        );
        expect(notified).toEqual([
            { userId: BOB, type: "chat.meeting.invited", href: `/chat/meetings/${MEETING}` }
        ]);

        // Asked again: nothing stored twice, nobody alerted twice.
        expect(await actions.inviteToMeetingAction({ meetingId: MEETING, userIds: [BOB] })).toEqual(
            {
                invited: 0
            }
        );
        expect(invites).toHaveLength(1);
        expect(notified).toHaveLength(1);
    });

    it("records addresses, normalized, and refuses them for accounts-only meetings", async () => {
        await actions.inviteToMeetingAction({ meetingId: MEETING, emails: [" Ada@Example.COM "] });
        expect(emails.map((row) => row.email)).toEqual(["ada@example.com"]);
        expect(notified).toHaveLength(0);

        meeting.requireAccount = true;
        const refused = await actions.inviteToMeetingAction({
            meetingId: MEETING,
            userIds: [BOB],
            emails: ["c@d.io"]
        });
        expect(refused.error).toBeTruthy();
        // The refusal comes before anybody is convened.
        expect(invites).toHaveLength(0);
        expect(notified).toHaveLength(0);
    });

    it("takes an address back off the list", async () => {
        emails.push({ meetingId: MEETING, email: "a@b.io" });
        expect(
            await actions.uninviteEmailFromMeetingAction({ meetingId: MEETING, email: "A@B.io" })
        ).not.toHaveProperty("error");
        expect(emails).toHaveLength(0);
    });
});

describe("removing somebody's invitation", () => {
    it("closes the meeting's page to them, but not the link", async () => {
        invites.push({ meetingId: MEETING, userId: BOB });
        const bob = { id: BOB, name: "Bob" };

        // Invited: walks straight in.
        const first = await meetings.joinMeeting(bob, MEETING);
        expect(first.admission).toBe("admitted");
        seats[0]!.leftAt = new Date();

        await actions.uninviteFromMeetingAction(MEETING, BOB);
        expect(invites).toHaveLength(0);
        await expect(meetings.joinMeeting(bob, MEETING)).rejects.toMatchObject({
            text: { key: "errors.meetingNotInvited" }
        });

        // The link still leads to the door, like anybody else holding it.
        const knocked = await meetings.joinOnLink(bob, "token-1");
        expect(knocked.admission).toBe("waiting");
    });

    it("leaves somebody already in the room where they are", async () => {
        seats.push({
            id: "s0",
            meetingId: MEETING,
            userId: BOB,
            admission: "admitted",
            leftAt: null
        });
        const seat = await meetings.joinMeeting({ id: BOB, name: "Bob" }, MEETING);
        expect(seat.participantId).toBe("s0");
    });

    it("refuses a stranger by id, as before an invitation existed", async () => {
        await expect(meetings.joinMeeting({ id: EVE, name: "Eve" }, MEETING)).rejects.toMatchObject(
            { text: { key: "errors.meetingNotInvited" } }
        );
        // The host is never a stranger.
        expect((await meetings.joinMeeting({ id: HOST, name: "Host" }, MEETING)).admission).toBe(
            "admitted"
        );
    });
});

describe("the join code", () => {
    it("a new code stops the old one at once", async () => {
        const old = meeting.joinCode!;
        expect(await meetings.guestTokenForJoinCode(old)).toBe("token-1");

        const result = await actions.setJoinCodeAction({ meetingId: MEETING, on: true });
        expect(result.joinCode).toMatch(/^[A-Z2-9]{9}$/);
        expect(result.joinCode).not.toBe(old);
        expect(await meetings.guestTokenForJoinCode(old)).toBeNull();
        expect(await meetings.guestTokenForJoinCode(result.joinCode!)).toBe("token-1");
    });

    it("removing the code leaves nothing to type", async () => {
        const old = meeting.joinCode!;
        expect(await actions.setJoinCodeAction({ meetingId: MEETING, on: false })).toEqual({
            joinCode: null
        });
        expect(meeting.joinCode).toBeNull();
        expect(await meetings.guestTokenForJoinCode(old)).toBeNull();
    });

    it("is refused on a meeting that has ended", async () => {
        meeting.endedAt = new Date();
        expect((await actions.setJoinCodeAction({ meetingId: MEETING, on: true })).error).toBe(
            "That meeting has ended"
        );
    });
});
