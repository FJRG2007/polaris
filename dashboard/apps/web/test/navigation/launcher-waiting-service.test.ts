/**
 * The entries behind each badge, and what marking them read does.
 *
 * Chat lists what its badge counts - conversations the reader is in, not muted,
 * not archived, with something unread - newest first, and marks them read the
 * way Chat does. Mail lists the newest unread threads of the open shelf's
 * inboxes and reads them on the mail server through Mail's own action. A group
 * the reader cannot reach is never asked for.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const chatRead: string[][] = [];
const mailRead: { ids: string[]; scope?: string }[] = [];
const dismissed: string[][] = [];
let mailIdsLeft = 0;

vi.mock("@polaris/db", () => ({
    prisma: {
        chatChannelMember: {
            findMany: async () => [
                { channelId: "a", muted: false, mutedUntil: null },
                { channelId: "b", muted: true, mutedUntil: null },
                { channelId: "c", muted: false, mutedUntil: null },
                { channelId: "d", muted: false, mutedUntil: null }
            ]
        },
        mailMessage: {
            groupBy: async () => [{ threadId: "t1", _count: { _all: 2 }, _max: { sentAt: new Date() } }],
            count: async () => 9,
            findMany: async ({ select, where }: { select: Record<string, true>; where: { threadId?: unknown } }) => {
                if (select.subject)
                    return [
                        {
                            threadId: "t1",
                            subject: "  ",
                            fromJson: [{ name: "Grace", address: "grace@example.test" }]
                        }
                    ];
                if (where.threadId) return [{ id: "m1" }, { id: "m2" }];
                const batch = Math.min(mailIdsLeft, 500);
                mailIdsLeft -= batch;
                return Array.from({ length: batch }, (_, at) => ({ id: `x${at}` }));
            }
        }
    }
}));
vi.mock("@/lib/chat/chat-service", () => ({
    listChannels: async () => [
        { id: "a", name: "Ada", unread: 3, archived: false, lastMessageAt: "2026-10-01T00:00:00Z" },
        { id: "b", name: "Muted", unread: 9, archived: false, lastMessageAt: "2026-10-03T00:00:00Z" },
        { id: "c", name: "Ops", unread: 1, archived: false, lastMessageAt: "2026-10-02T00:00:00Z" },
        { id: "d", name: "Old", unread: 4, archived: true, lastMessageAt: "2026-10-04T00:00:00Z" },
        { id: "e", name: "Public", unread: 6, archived: false, lastMessageAt: "2026-10-05T00:00:00Z" }
    ]
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

beforeEach(() => {
    chatRead.length = 0;
    mailRead.length = 0;
    dismissed.length = 0;
    mailIdsLeft = 0;
});

describe("what the menu lists", () => {
    it("lists only what each badge counts, newest first", async () => {
        const groups = await launcherWaiting("ada", { chat: true, mail: true, admin: true });
        const chat = groups.find((group) => group.app === "chat");
        expect(chat?.items.map((item) => item.title)).toEqual(["Ops", "Ada"]);
        expect(chat?.total).toBe(4);
        const mail = groups.find((group) => group.app === "mail");
        expect(mail).toMatchObject({
            total: 9,
            items: [{ id: "t1", title: "Grace", detail: "", href: "/mail/t/t1", count: 2 }]
        });
        const admin = groups.find((group) => group.app === "admin");
        expect(admin?.items.map((item) => [item.id, item.dismissable])).toEqual([
            ["reports", true],
            ["update", true],
            ["apis", false]
        ]);
    });

    it("never asks for an app the reader cannot reach", async () => {
        const groups = await launcherWaiting("ada", { chat: false, mail: false, admin: false });
        expect(groups).toEqual([]);
    });
});

describe("marking read", () => {
    it("reads a conversation, or every one the badge counts", async () => {
        await markLauncherRead("ada", "chat", "a");
        await markLauncherRead("ada", "chat", null);
        expect(chatRead).toEqual([["a"], ["c", "a"]]);
    });

    it("reads a mail thread as a conversation, the way Mail does", async () => {
        await markLauncherRead("ada", "mail", "t1");
        expect(mailRead).toEqual([{ ids: ["m1", "m2"], scope: "conversation" }]);
    });

    it("reads all unread mail in batches until none is left", async () => {
        mailIdsLeft = 1200;
        await markLauncherRead("ada", "mail", null);
        expect(mailRead.map((call) => call.ids.length)).toEqual([500, 500, 200]);
    });

    it("marks Management entries seen, and an unknown one not at all", async () => {
        await markLauncherRead("ada", "admin", "update");
        await markLauncherRead("ada", "admin", "nonsense");
        await markLauncherRead("ada", "admin", null);
        expect(dismissed).toEqual([["update"], ["reports", "cases", "update"]]);
    });
});
