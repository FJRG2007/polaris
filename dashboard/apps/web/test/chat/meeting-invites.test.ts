/**
 * Inviting people while a meeting is made, and the join code.
 *
 * **What is accepted.** Addresses are trimmed and lowercased before they are
 * checked, so " Ada@Example.COM " is one address and a typo is refused rather
 * than stored. A meeting only open to Polaris accounts takes no addresses at
 * all: the person behind one has no account the link would let in.
 *
 * **The code.** It is stored as typed-and-normalized, leads only to the
 * meeting's own guest link, answers the same for a code that names nothing and
 * one whose meeting is over, and every try - a malformed one included - counts
 * against the address it came from.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface MeetingRow {
    id: string;
    joinCode: string | null;
    guestToken: string | null;
    endedAt: Date | null;
}

let rows: MeetingRow[] = [];
let createdData: Record<string, unknown>[] = [];
let counters = new Map<string, { count: number; windowStart: Date }>();
/** How many of the next creates collide on their code, as a unique index would. */
let collisions = 0;
let refused: string[] = [];

vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));
vi.mock("@/lib/blocks", () => ({ blockersOf: async () => new Set<string>() }));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => null,
    getIntegrationSecret: async () => null
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/meeting-events", () => ({ publishMeetingEvent: () => undefined }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/request-context", () => ({
    clientIp: async () => "203.0.113.7",
    hashForLog: (value: string | null) => (value ? `h:${value}` : null)
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.filter((id) => id !== "gone").map((id) => ({ id }))
        },
        meeting: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
                const code = data.joinCode as string | null;
                if (code && collisions > 0) {
                    collisions -= 1;
                    refused.push(code);
                    throw Object.assign(new Error("unique"), { code: "P2002" });
                }
                createdData.push(data);
                const row = {
                    id: `m${rows.length + 1}`,
                    joinCode: code,
                    guestToken: data.guestToken as string,
                    endedAt: null
                };
                rows.push(row);
                return { id: row.id };
            },
            findUnique: async ({ where }: { where: { joinCode?: string } }) =>
                rows.find((row) => row.joinCode === where.joinCode) ?? null
        },
        rateLimitCounter: {
            findUnique: async ({ where }: { where: { key: string } }) =>
                counters.get(where.key) ?? null,
            upsert: async ({ where, create }: { where: { key: string }; create: never }) => {
                const { count, windowStart } = create as { count: number; windowStart: Date };
                counters.set(where.key, { count, windowStart });
            },
            update: async ({ where }: { where: { key: string } }) => {
                counters.get(where.key)!.count += 1;
            },
            deleteMany: async () => ({ count: 0 })
        }
    }
}));

const invites = await import("@/lib/chat/meeting-invites");
const meetings = await import("@/lib/chat/meetings");
const { joinWithCodeAction } = await import("@/app/m/actions");

const ADA = "0190a1b2-0000-7000-8000-000000000001";
const BOB = "0190a1b2-0000-7000-8000-000000000002";
const base = { title: "Planning", scheduledAt: null, approveGuests: true, requireAccount: false };

beforeEach(() => {
    rows = [];
    createdData = [];
    counters = new Map();
    collisions = 0;
    refused = [];
});

describe("invite validation", () => {
    it("normalizes an address before checking it, and refuses one that is not", () => {
        const parsed = invites.meetingInvitesSchema.parse({ emails: ["  Ada@Example.COM "] });
        expect(parsed.emails).toEqual(["ada@example.com"]);
        expect(invites.meetingInvitesSchema.safeParse({ emails: ["ada@"] }).success).toBe(false);
        expect(invites.meetingInvitesSchema.safeParse({ emails: ["   "] }).success).toBe(false);
    });

    it("takes nothing by default, and caps people and addresses", () => {
        expect(invites.meetingInvitesSchema.parse({})).toEqual({
            userIds: [],
            emails: [],
            joinCode: false
        });
        const many = Array.from({ length: invites.MOST_EMAILS + 1 }, (_, i) => `p${i}@x.io`);
        expect(invites.meetingInvitesSchema.safeParse({ emails: many }).success).toBe(false);
        expect(invites.meetingInvitesSchema.safeParse({ userIds: ["not-a-uuid"] }).success).toBe(
            false
        );
    });

    it("reads a typed code however it was copied, and nothing that is not one", () => {
        expect(invites.normalizeJoinCode("abc-def-ghj")).toBe("ABCDEFGHJ");
        expect(invites.normalizeJoinCode(" ABC DEF GHJ ")).toBe("ABCDEFGHJ");
        // 0, O, 1, I and L are never in a code, so they cannot be typed into one.
        expect(invites.normalizeJoinCode("ABC-DEF-GH0")).toBeNull();
        expect(invites.normalizeJoinCode("ABCDEFGH")).toBeNull();
        expect(invites.formatJoinCode("ABCDEFGHJ")).toBe("ABC-DEF-GHJ");
    });

    it("draws codes only from the unambiguous alphabet", () => {
        for (let i = 0; i < 200; i++) {
            const code = meetings.generateJoinCode();
            expect(invites.normalizeJoinCode(code)).toBe(code);
        }
    });
});

describe("Polaris accounts only", () => {
    it("refuses addresses, and only addresses", async () => {
        expect(invites.inviteRefusal({ requireAccount: true, emails: ["a@b.co"] })).toBe(
            "errors.meetingEmailsNeedGuests"
        );
        expect(invites.inviteRefusal({ requireAccount: true, emails: [] })).toBeNull();
        expect(invites.inviteRefusal({ requireAccount: false, emails: ["a@b.co"] })).toBeNull();

        await expect(
            meetings.createMeeting(
                { id: ADA },
                { ...base, requireAccount: true, emails: ["a@b.co"] }
            )
        ).rejects.toMatchObject({ text: { key: "errors.meetingEmailsNeedGuests" } });
        expect(createdData).toHaveLength(0);

        const made = await meetings.createMeeting(
            { id: ADA },
            { ...base, requireAccount: true, userIds: [BOB] }
        );
        expect(made.invited).toEqual([BOB]);
    });
});

describe("creating with invitations", () => {
    it("stores real people and addresses, never the host, and mints a code when asked", async () => {
        const made = await meetings.createMeeting(
            { id: ADA },
            {
                ...base,
                userIds: [BOB, ADA, "gone", BOB],
                emails: ["c@d.io", "c@d.io"],
                joinCode: true
            }
        );
        expect(made.invited).toEqual([BOB]);
        expect(made.joinCode).toMatch(/^[A-Z2-9]{9}$/);
        const data = createdData[0] as {
            invites: { create: { userId: string }[] };
            emailInvites: { create: { email: string }[] };
        };
        expect(data.invites.create.map((row) => row.userId)).toEqual([BOB]);
        expect(data.emailInvites.create.map((row) => row.email)).toEqual(["c@d.io"]);
    });

    it("draws another code when the first is already somebody else's", async () => {
        collisions = 1;
        const made = await meetings.createMeeting({ id: ADA }, { ...base, joinCode: true });
        expect(refused).toHaveLength(1);
        expect(made.joinCode).toMatch(/^[A-Z2-9]{9}$/);
        expect(createdData).toHaveLength(1);
    });

    it("gives up rather than drawing forever", async () => {
        collisions = 99;
        await expect(
            meetings.createMeeting({ id: ADA }, { ...base, joinCode: true })
        ).rejects.toMatchObject({ code: "P2002" });
        expect(refused).toHaveLength(3);
    });

    it("mints no code unless asked", async () => {
        const made = await meetings.createMeeting({ id: ADA }, base);
        expect(made.joinCode).toBeNull();
    });
});

describe("joining with a code", () => {
    it("leads to the meeting's own link, however the code was typed", async () => {
        const made = await meetings.createMeeting({ id: ADA }, { ...base, joinCode: true });
        const typed = invites.formatJoinCode(made.joinCode!).toLowerCase();
        expect(await joinWithCodeAction(typed)).toEqual({ to: `/m/${made.guestToken}` });
    });

    it("answers the same for a code that names nothing, one that ended and one with no link", async () => {
        const made = await meetings.createMeeting({ id: ADA }, { ...base, joinCode: true });
        const unknown = await joinWithCodeAction("ZZZ-ZZZ-ZZZ");
        rows[0]!.endedAt = new Date();
        const ended = await joinWithCodeAction(made.joinCode!);
        rows[0]!.endedAt = null;
        rows[0]!.guestToken = null;
        const shut = await joinWithCodeAction(made.joinCode!);
        const malformed = await joinWithCodeAction("not a code");
        const notText = await joinWithCodeAction({ code: made.joinCode });
        for (const answer of [unknown, ended, shut, malformed, notText]) {
            expect(answer).toEqual({ error: "meetingCode.notFound" });
        }
    });

    it("stops answering an address after ten tries, malformed ones included", async () => {
        const made = await meetings.createMeeting({ id: ADA }, { ...base, joinCode: true });
        for (let i = 0; i < 10; i++) {
            expect(await joinWithCodeAction(i % 2 ? "nope" : "ZZZ-ZZZ-ZZZ")).toEqual({
                error: "meetingCode.notFound"
            });
        }
        // Even the right code is refused once the window is spent.
        expect(await joinWithCodeAction(made.joinCode!)).toEqual({ error: "meetingCode.tooMany" });
        expect(counters.get("meeting-code:h:203.0.113.7")?.count).toBe(10);
    });
});
