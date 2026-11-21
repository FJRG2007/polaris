/**
 * The second tick: a device of the recipient has the message.
 *
 * It used to be recorded only when the conversation was opened - which also
 * reads it - so the sender went from one tick straight to two in colour. Now a
 * screen told a message arrived acknowledges it, and so does loading Polaris.
 * The rules: only the caller's own marks move, only forwards, only in their own
 * conversations, one write per burst, and the senders are told live.
 *
 * The database is a small in-memory model of the one statement `markDelivered`
 * runs; the statement's text is asserted for the guards that model stands for.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ADA = "0190f0a0-0000-7000-8000-00000000000a";
const GRACE = "0190f0a0-0000-7000-8000-00000000000b";
const LINUS = "0190f0a0-0000-7000-8000-00000000000c";
const DM = "0190f0a0-0000-7000-8000-0000000000d1";
const GROUP = "0190f0a0-0000-7000-8000-0000000000d2";
const ROOM = "0190f0a0-0000-7000-8000-0000000000d3";
const FOREIGN = "0190f0a0-0000-7000-8000-0000000000d4";

interface Channel {
    id: string;
    kind: string;
    spaceId: string | null;
    lastMessageAt: Date | null;
}
interface Member {
    channelId: string;
    userId: string;
    lastDeliveredAt: Date | null;
}
interface Message {
    channelId: string;
    authorId: string;
    createdAt: Date;
}

const T0 = new Date("2026-11-21T10:00:00Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

let channels: Channel[] = [];
let members: Member[] = [];
let messages: Message[] = [];
let statements: string[] = [];
let stamped: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
let announced: { kind: string; channelId: string; actorId: string; audience?: readonly string[] }[] = [];
let chatRule: "follow" | "on" | "off" = "follow";
let limited = false;

vi.mock("@polaris/db", () => ({
    prisma: {
        // The guarded update. Positions follow the template in `delivered.ts`:
        // the moment, the caller, "everywhere", the named conversations.
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            statements.push(strings.join("?"));
            const [now, userId, everywhere, ids] = values as [string, string, boolean, string[]];
            const moment = new Date(now);
            const moved = [];
            for (const member of members) {
                if (member.userId !== userId) continue;
                if (!everywhere && !ids.includes(member.channelId)) continue;
                const channel = channels.find((one) => one.id === member.channelId)!;
                if (channel.spaceId || !["dm", "group"].includes(channel.kind)) continue;
                const mark = member.lastDeliveredAt?.getTime() ?? -Infinity;
                if (!channel.lastMessageAt || channel.lastMessageAt.getTime() <= mark) continue;
                const fresh = messages.some(
                    (message) =>
                        message.channelId === channel.id &&
                        message.authorId !== userId &&
                        message.createdAt.getTime() > mark
                );
                if (!fresh) continue;
                const reach = new Date(Math.max(moment.getTime(), channel.lastMessageAt.getTime()));
                if (member.lastDeliveredAt && member.lastDeliveredAt >= reach) continue;
                moved.push({ channelId: channel.id, kind: channel.kind, previous: member.lastDeliveredAt, reach });
                member.lastDeliveredAt = reach;
            }
            return moved;
        },
        chatMessage: {
            updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
                stamped.push(args);
                return { count: 0 };
            }
        },
        chatChannelMember: {
            findMany: async ({ where }: { where: { channelId: { in: string[] }; userId: { not: string } } }) =>
                members.filter(
                    (member) => where.channelId.in.includes(member.channelId) && member.userId !== where.userId.not
                )
        }
    }
}));

vi.mock("@/lib/chat/live", () => ({
    publishChatChange: (change: (typeof announced)[number]) => {
        announced.push(change);
    }
}));

vi.mock("@/lib/chat/vanish", () => ({
    chatPrivacyIn: async (ids: readonly string[]) =>
        new Map(ids.map((id) => [id, { receipts: chatRule, typing: "follow" }]))
}));

vi.mock("@/lib/session", () => ({
    backgroundUser: async () => (signedIn ? { id: ADA } : null),
    sessionCan: async () => true
}));
let signedIn = true;

vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => ({ ok: !limited, retryAfterMs: limited ? 1000 : 0 })
}));

const { markDelivered, deliverEverywhere } = await import("@/lib/chat/delivered");
const { POST } = await import("@/app/api/chat/delivered/route");

function post(body: unknown, type = "application/json"): Promise<Response> {
    return POST(
        new Request("http://polaris.test/api/chat/delivered", {
            method: "POST",
            headers: { "content-type": type },
            body: JSON.stringify(body)
        })
    );
}

beforeEach(() => {
    chatRule = "follow";
    limited = false;
    signedIn = true;
    statements = [];
    stamped = [];
    announced = [];
    channels = [
        { id: DM, kind: "dm", spaceId: null, lastMessageAt: at(10) },
        { id: GROUP, kind: "group", spaceId: null, lastMessageAt: at(10) },
        { id: ROOM, kind: "text", spaceId: "space", lastMessageAt: at(10) },
        { id: FOREIGN, kind: "dm", spaceId: null, lastMessageAt: at(10) }
    ];
    members = [
        { channelId: DM, userId: ADA, lastDeliveredAt: at(0) },
        { channelId: DM, userId: GRACE, lastDeliveredAt: null },
        { channelId: GROUP, userId: ADA, lastDeliveredAt: null },
        { channelId: GROUP, userId: GRACE, lastDeliveredAt: null },
        { channelId: GROUP, userId: LINUS, lastDeliveredAt: null },
        { channelId: ROOM, userId: ADA, lastDeliveredAt: null },
        { channelId: FOREIGN, userId: GRACE, lastDeliveredAt: null },
        { channelId: FOREIGN, userId: LINUS, lastDeliveredAt: null }
    ];
    messages = [
        { channelId: DM, authorId: GRACE, createdAt: at(10) },
        { channelId: GROUP, authorId: LINUS, createdAt: at(10) },
        { channelId: ROOM, authorId: GRACE, createdAt: at(10) },
        { channelId: FOREIGN, authorId: LINUS, createdAt: at(10) }
    ];
});

describe("the statement", () => {
    it("only ever writes the caller's own rows, forwards, after somebody else's message", async () => {
        await markDelivered(ADA, [DM], at(20));
        const sql = statements[0]!;
        expect(sql).toContain('m."userId" = ?::uuid');
        expect(sql).toContain('x."authorId" <> ?::uuid');
        expect(sql).toContain('t."lastDeliveredAt" < due.reach');
        expect(sql).toContain("FOR UPDATE OF m SKIP LOCKED");
        expect(sql).toContain("c.kind IN ('dm', 'group')");
    });
});

describe("acknowledging", () => {
    it("moves the mark and tells the sender", async () => {
        expect(await markDelivered(ADA, [DM], at(20))).toEqual([DM]);
        expect(members[0]!.lastDeliveredAt).toEqual(at(20));
        expect(announced).toEqual([{ channelId: DM, kind: "delivered", actorId: ADA, audience: [GRACE] }]);
    });

    it("is idempotent: a second acknowledgement writes and announces nothing", async () => {
        await markDelivered(ADA, [DM], at(20));
        announced = [];
        stamped = [];
        expect(await markDelivered(ADA, [DM], at(21))).toEqual([]);
        expect(announced).toEqual([]);
        expect(stamped).toEqual([]);
    });

    it("never moves the mark backwards", async () => {
        members[0]!.lastDeliveredAt = at(30);
        expect(await markDelivered(ADA, [DM], at(20))).toEqual([]);
        expect(members[0]!.lastDeliveredAt).toEqual(at(30));
    });

    it("reaches a message stamped by a clock a little ahead", async () => {
        channels[0]!.lastMessageAt = at(25);
        messages[0]!.createdAt = at(25);
        await markDelivered(ADA, [DM], at(20));
        expect(members[0]!.lastDeliveredAt).toEqual(at(25));
    });

    it("is not moved by the caller's own message", async () => {
        messages = [{ channelId: DM, authorId: ADA, createdAt: at(10) }];
        expect(await markDelivered(ADA, [DM], at(20))).toEqual([]);
        expect(announced).toEqual([]);
    });

    it("cannot touch a conversation the caller is not in", async () => {
        expect(await markDelivered(ADA, [FOREIGN], at(20))).toEqual([]);
        expect(members.filter((member) => member.channelId === FOREIGN).map((m) => m.lastDeliveredAt)).toEqual([
            null,
            null
        ]);
        expect(announced).toEqual([]);
    });

    it("leaves rooms of a space alone: nothing draws ticks there", async () => {
        expect(await markDelivered(ADA, [ROOM], at(20))).toEqual([]);
    });

    it("stamps the moment on one-to-one messages, bounded by the mark it replaces", async () => {
        await markDelivered(ADA, [DM, GROUP], at(20));
        expect(stamped).toHaveLength(1);
        expect(stamped[0]!.where).toEqual({
            authorId: { not: ADA },
            deliveredAt: null,
            OR: [{ channelId: DM, createdAt: { lte: at(20), gte: at(0) } }]
        });
        expect(stamped[0]!.data).toEqual({ deliveredAt: at(20) });
    });

    it("tells every other member of a group, and nobody in a chat whose rule is off", async () => {
        await markDelivered(ADA, [GROUP], at(20));
        expect(announced[0]?.audience).toEqual([GRACE, LINUS]);
        announced = [];
        chatRule = "off";
        messages.push({ channelId: DM, authorId: GRACE, createdAt: at(10) });
        await markDelivered(ADA, [DM], at(20));
        expect(announced).toEqual([]);
    });

    it("asks nothing for an empty list", async () => {
        expect(await markDelivered(ADA, [], at(20))).toEqual([]);
        expect(statements).toEqual([]);
    });
});

describe("loading Polaris", () => {
    it("delivers every conversation with something new in one pass", async () => {
        await deliverEverywhere(ADA);
        expect(members.find((m) => m.channelId === DM && m.userId === ADA)!.lastDeliveredAt).not.toEqual(at(0));
        expect(members.find((m) => m.channelId === GROUP && m.userId === ADA)!.lastDeliveredAt).not.toBeNull();
        expect(announced.map((change) => change.channelId).sort()).toEqual([DM, GROUP].sort());
    });
});

describe("the route", () => {
    it("acknowledges the caller's conversations", async () => {
        const response = await post({ channelIds: [DM, FOREIGN] });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ moved: 1 });
    });

    it("refuses what is not a list of conversation ids", async () => {
        expect((await post({ channelIds: ["not-an-id"] })).status).toBe(400);
        expect((await post({ channelIds: [] })).status).toBe(400);
        expect((await post({ channelIds: Array.from({ length: 101 }, () => DM) })).status).toBe(400);
        expect((await post({ channelIds: [DM] }, "text/plain")).status).toBe(415);
    });

    it("refuses somebody signed out, and holds back past the rate limit", async () => {
        signedIn = false;
        expect((await post({ channelIds: [DM] })).status).toBe(401);
        signedIn = true;
        limited = true;
        expect((await post({ channelIds: [DM] })).status).toBe(429);
        expect(members[0]!.lastDeliveredAt).toEqual(at(0));
    });
});
