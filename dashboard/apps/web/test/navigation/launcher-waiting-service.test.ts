/**
 * The entries behind each badge, and what marking them read does.
 *
 * Chat lists what its badge counts - conversations the reader is in, not muted,
 * not archived, with something unread - newest first, names only the few it
 * lists. Mail lists the newest unread threads of the open shelf's inboxes. A
 * group the reader cannot reach is never asked for, and no subject or name is
 * long enough to fail the answer the menu validates.
 *
 * Marking a whole app read is the phone's gesture: the badge goes and nothing
 * inside the app is read. One named entry is that entry read, the app's way.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const chatRead: string[][] = [];
const mailRead: { ids: string[]; scope?: string }[] = [];
const dismissed: string[][] = [];
const named: string[][] = [];
let mailIdsLeft = 0;
let subject = "  ";
/** The badge marks kept, by `userId:key`. */
const marks = new Map<string, string>();
const published: { bus: string; change: Record<string, unknown> }[] = [];
const noticesRead: string[][] = [];
/** Every `where` the mail badge was counted with. */
const mailCounted: unknown[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        mailMessage: {
            groupBy: async ({ where }: { where: unknown }) => {
                mailCounted.push(where);
                return [{ threadId: "t1", _count: { _all: 2 }, _max: { sentAt: new Date() } }];
            },
            count: async () => 9,
            findMany: async ({ select, where }: { select: Record<string, true>; where: { threadId?: unknown } }) => {
                if (select.threadId && !select.id && !select.subject) return [{ threadId: "t1" }, { threadId: "t2" }];
                if (select.subject)
                    return [
                        {
                            threadId: "t1",
                            subject,
                            fromJson: [{ name: "Grace", address: "grace@example.test" }]
                        }
                    ];
                if (where.threadId) return [{ id: "m1" }, { id: "m2" }];
                const batch = Math.min(mailIdsLeft, 500);
                mailIdsLeft -= batch;
                return Array.from({ length: batch }, (_, at) => ({ id: `x${at}` }));
            }
        },
        userBadgeSeen: {
            findUnique: async ({ where }: { where: { userId_key: { userId: string; key: string } } }) => {
                const mark = marks.get(`${where.userId_key.userId}:${where.userId_key.key}`);
                return mark === undefined ? null : { mark };
            },
            upsert: async ({ create }: { create: { userId: string; key: string; mark: string } }) => {
                marks.set(`${create.userId}:${create.key}`, create.mark);
            }
        }
    }
}));
vi.mock("@/lib/mailbox/live", () => ({
    publishMail: (change: Record<string, unknown>) => published.push({ bus: "mail", change })
}));
vi.mock("@/lib/chat/live", () => ({
    publishChatChange: (change: Record<string, unknown>) => published.push({ bus: "chat", change })
}));
vi.mock("@/lib/mailbox/mail-notices", () => ({
    readNoticesAboutThreads: async (_user: string, threads: string[]) => {
        noticesRead.push(threads);
    }
}));
vi.mock("@/lib/chat/chat-service", () => ({
    unreadConversations: async () => [
        { id: "a", unread: 3, lastMessageAt: new Date("2026-10-01T00:00:00Z") },
        { id: "c", unread: 1, lastMessageAt: new Date("2026-10-02T00:00:00Z") }
    ],
    listChannels: async (_actor: unknown, only: string[]) => {
        named.push(only);
        const names: Record<string, string> = { a: "Ada", c: "Ops" };
        return only.map((id) => ({ id, name: names[id] }));
    }
}));
vi.mock("@/lib/chat/messages", () => ({
    markChannelsRead: async (_actor: unknown, input: { channelIds: string[] }) => {
        chatRead.push(input.channelIds);
    }
}));
vi.mock("@/lib/mailbox/messages", () => ({
    actOnMessages: async (_user: string, ids: string[], _action: string, options?: { scope?: string }) => {
        mailRead.push({ ids, scope: options?.scope });
        return ids.length;
    }
}));
vi.mock("@/lib/mailbox/shelf", () => ({ mailShelfFor: async () => null, isEveryShelf: () => false }));
vi.mock("@/lib/admin-waiting", () => ({
    adminWaiting: async () => ({ reports: 2, cases: 0, update: true, apis: 1, total: 4 }),
    dismissAdminWaiting: async (_user: string, ids: string[]) => {
        dismissed.push(ids);
    }
}));

const { launcherWaiting, markLauncherRead } = await import("@/lib/launcher-waiting-service");
const { LAUNCHER_TEXT_MAX, launcherWaitingSchema } = await import("@/lib/launcher-waiting");

beforeEach(() => {
    chatRead.length = 0;
    mailRead.length = 0;
    dismissed.length = 0;
    named.length = 0;
    mailIdsLeft = 0;
    subject = "  ";
    marks.clear();
    published.length = 0;
    noticesRead.length = 0;
    mailCounted.length = 0;
});

describe("what the menu lists", () => {
    it("lists only what each badge counts, newest first", async () => {
        const groups = await launcherWaiting("ada", { chat: true, mail: true, admin: true });
        const chat = groups.find((group) => group.app === "chat");
        expect(chat?.items.map((item) => item.title)).toEqual(["Ops", "Ada"]);
        expect(chat?.total).toBe(4);
        expect(named).toEqual([["c", "a"]]);
        const mail = groups.find((group) => group.app === "mail");
        expect(mail).toMatchObject({
            total: 9,
            items: [{ id: "t1", title: "Grace", detail: "", href: "/mail/t/t1", count: 2 }]
        });
        const admin = groups.find((group) => group.app === "admin");
        expect(admin?.items.map((item) => [item.id, item.dismissable])).toEqual([
            ["reports", true],
            ["update", true],
            ["apis", true]
        ]);
    });

    it("cuts a subject too long for the menu rather than failing the answer", async () => {
        subject = "x".repeat(LAUNCHER_TEXT_MAX + 50);
        const groups = await launcherWaiting("ada", { chat: true, mail: true, admin: true });
        expect(groups.find((group) => group.app === "mail")?.items[0]?.detail).toHaveLength(LAUNCHER_TEXT_MAX);
        expect(launcherWaitingSchema.safeParse({ groups }).success).toBe(true);
    });

    it("never asks for an app the reader cannot reach", async () => {
        const groups = await launcherWaiting("ada", { chat: false, mail: false, admin: false });
        expect(groups).toEqual([]);
    });
});

describe("marking read", () => {
    it("reads one named conversation the way Chat does", async () => {
        await markLauncherRead("ada", "chat", "a");
        expect(chatRead).toEqual([["a"]]);
    });

    it("clears Chat's badge without reading a single conversation", async () => {
        await markLauncherRead("ada", "chat", null);
        expect(chatRead).toEqual([]);
        expect(marks.has("ada:cleared.chat")).toBe(true);
        expect(published).toEqual([
            { bus: "chat", change: { kind: "badge", actorId: "ada", audience: ["ada"] } }
        ]);
    });

    it("reads a mail thread as a conversation, the way Mail does", async () => {
        await markLauncherRead("ada", "mail", "t1");
        expect(mailRead).toEqual([{ ids: ["m1", "m2"], scope: "conversation" }]);
    });

    it("clears Mail's badge without reading a single message", async () => {
        mailIdsLeft = 1200;
        await markLauncherRead("ada", "mail", null);
        expect(mailRead).toEqual([]);
        expect(marks.has("ada:cleared.mail")).toBe(true);
        // The bell's notices about those conversations go with the badge.
        expect(noticesRead).toEqual([["t1", "t2"]]);
        expect(published).toEqual([
            { bus: "mail", change: { kind: "badge", accountId: "", actorId: "ada" } }
        ]);
    });

    it("lists only mail that arrived after the badge was cleared", async () => {
        await launcherWaiting("ada", { chat: false, mail: true, admin: false });
        expect(JSON.stringify(mailCounted.at(-1))).not.toContain("createdAt");
        await markLauncherRead("ada", "mail", null);
        const cleared = marks.get("ada:cleared.mail")!;
        await launcherWaiting("ada", { chat: false, mail: true, admin: false });
        expect(mailCounted.at(-1)).toMatchObject({ createdAt: { gt: new Date(cleared) } });
    });

    it("marks Management entries seen, and an unknown one not at all", async () => {
        await markLauncherRead("ada", "admin", "update");
        await markLauncherRead("ada", "admin", "nonsense");
        await markLauncherRead("ada", "admin", null);
        expect(dismissed).toEqual([["update"], ["reports", "cases", "update", "apis"]]);
    });
});
