/**
 * Reminders on messages: set, bounded, and fired once - to the right person,
 * only while they can still read the room, and without quoting a message that
 * was deleted in between.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-09-01T12:00:00Z");

interface Row {
    id: string;
    userId: string;
    messageId: string;
    dueAt: Date;
    firedAt: Date | null;
}

let rows: Row[] = [];
let message: { channelId: string; body: string; deletedAt: Date | null } | null = null;
/** Whether the reader still reaches the room. */
let reachable = true;
/** Whether the history floor lets them read this message. */
let readable = true;
let alerts: { userId: string; title: string; body?: string | null; href?: string | null }[] = [];

/** The access layer's refusal, without loading the access layer (which pulls
 *  in the whole auth stack). */
class Refused extends Error {
    constructor(readonly text: unknown = null) {
        super("refused");
    }
}

vi.mock("@/lib/chat/access", () => ({
    ChatAccessError: Refused,
    channelAccess: async () => (reachable ? { channelId: "c1" } : null),
    requireChannel: async () => {
        if (!reachable) throw new Refused();
        return { channelId: "c1" };
    },
    reachableChannelIds: async () => new Set(reachable ? ["c1"] : [])
}));

vi.mock("@/lib/chat/history-visibility", () => ({
    readableSince: async () => null,
    isReadable: () => readable,
    requireReadable: async () => {
        if (!readable) throw new Refused();
    }
}));

vi.mock("@/lib/chat/text", () => ({
    chatWordsFor: async () => (key: string) => key
}));

vi.mock("@/lib/chat/isolation", () => ({ chatAlertShelf: async () => undefined }));

vi.mock("@/lib/notifications/dispatch", () => ({
    notify: async (input: (typeof alerts)[number]) => {
        alerts.push(input);
        return { inapp: "created" };
    }
}));

vi.mock("@/components/rich-text/excerpt", () => ({
    plainExcerpt: (body: string) => body
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatMessage: {
            findUnique: async () =>
                message && {
                    ...message,
                    createdAt: NOW,
                    channel: { orgId: null, space: null }
                }
        },
        chatReminder: {
            findUnique: async ({ where }: { where: { userId_messageId: Row } }) =>
                rows.find(
                    (row) =>
                        row.userId === where.userId_messageId.userId &&
                        row.messageId === where.userId_messageId.messageId
                ) ?? null,
            count: async ({ where }: { where: { userId: string } }) =>
                rows.filter((row) => row.userId === where.userId && row.firedAt === null).length,
            upsert: async ({
                where,
                create,
                update
            }: {
                where: { userId_messageId: Row };
                create: Omit<Row, "id" | "firedAt">;
                update: Partial<Row>;
            }) => {
                const found = rows.find(
                    (row) =>
                        row.userId === where.userId_messageId.userId &&
                        row.messageId === where.userId_messageId.messageId
                );
                if (found) Object.assign(found, update);
                else rows.push({ id: `r${rows.length + 1}`, firedAt: null, ...create });
            },
            deleteMany: async () => ({ count: 0 }),
            findMany: async () =>
                rows.filter((row) => row.firedAt === null && row.dueAt <= NOW).map((row) => ({ ...row })),
            updateMany: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
                const found = rows.find((row) => row.id === where.id && row.firedAt === null);
                if (!found) return { count: 0 };
                Object.assign(found, data);
                return { count: 1 };
            }
        }
    }
}));

const { setReminder, sweepDueReminders } = await import("@/lib/chat/reminders");

const ME = { id: "u1" };
const MESSAGE_ID = "0190a1b2-0000-7000-8000-000000000001";
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

beforeEach(() => {
    rows = [];
    alerts = [];
    reachable = true;
    readable = true;
    message = { channelId: "c1", body: "Ship it on Friday", deletedAt: null };
});

describe("the reminder schema", () => {
    it("takes a message id and an instant, and nothing looser", () => {
        expect(
            core.chatReminderSchema.safeParse({ messageId: MESSAGE_ID, dueAt: inMinutes(5) })
                .success
        ).toBe(true);
        expect(
            core.chatReminderSchema.safeParse({ messageId: "nope", dueAt: inMinutes(5) }).success
        ).toBe(false);
        expect(
            core.chatReminderSchema.safeParse({ messageId: MESSAGE_ID, dueAt: "tomorrow" })
                .success
        ).toBe(false);
    });
});

describe("setting a reminder", () => {
    it("writes one row, and moves it rather than adding a second", async () => {
        await setReminder(ME, { messageId: MESSAGE_ID, dueAt: inMinutes(15) });
        const later = inMinutes(60);
        expect(await setReminder(ME, { messageId: MESSAGE_ID, dueAt: later })).toBe(later);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.dueAt.toISOString()).toBe(later);
    });

    it("refuses a moment in the past", async () => {
        await expect(
            setReminder(ME, { messageId: MESSAGE_ID, dueAt: inMinutes(-5) })
        ).rejects.toThrow();
        expect(rows).toHaveLength(0);
    });

    it("refuses a deleted message, and a room the reader cannot open", async () => {
        message = { channelId: "c1", body: "", deletedAt: NOW };
        await expect(
            setReminder(ME, { messageId: MESSAGE_ID, dueAt: inMinutes(15) })
        ).rejects.toThrow();
        message = { channelId: "c1", body: "x", deletedAt: null };
        reachable = false;
        await expect(
            setReminder(ME, { messageId: MESSAGE_ID, dueAt: inMinutes(15) })
        ).rejects.toThrow();
        expect(rows).toHaveLength(0);
    });

    it("stops at the bound on pending reminders", async () => {
        for (let index = 0; index < core.MAX_PENDING_REMINDERS; index++) {
            rows.push({
                id: `p${index}`,
                userId: ME.id,
                messageId: `other-${index}`,
                dueAt: new Date(inMinutes(30)),
                firedAt: null
            });
        }
        await expect(
            setReminder(ME, { messageId: MESSAGE_ID, dueAt: inMinutes(15) })
        ).rejects.toThrow();
    });
});

describe("firing", () => {
    const due = () =>
        rows.push({
            id: "r1",
            userId: ME.id,
            messageId: MESSAGE_ID,
            dueAt: new Date(NOW.getTime() - 1000),
            firedAt: null
        });

    it("tells the reader once, with the message and a link to it", async () => {
        due();
        expect((await sweepDueReminders(NOW)).sent).toBe(1);
        expect(alerts).toEqual([
            {
                userId: ME.id,
                event: "chat.reminder",
                title: "notices.reminder",
                body: "Ship it on Friday",
                href: `/chat/c/c1/${MESSAGE_ID}`,
                shelf: undefined
            }
        ]);
        // A second pass over the same minute finds it claimed.
        expect((await sweepDueReminders(NOW)).sent).toBe(0);
        expect(alerts).toHaveLength(1);
    });

    it("says nothing at all once the reader lost the room", async () => {
        due();
        reachable = false;
        expect((await sweepDueReminders(NOW)).unreadable).toBe(1);
        expect(alerts).toHaveLength(0);
        expect(rows[0]!.firedAt).not.toBeNull();
    });

    it("says nothing when the history floor hides the message", async () => {
        due();
        readable = false;
        await sweepDueReminders(NOW);
        expect(alerts).toHaveLength(0);
    });

    it("says the message was deleted, and quotes none of it", async () => {
        due();
        message = { channelId: "c1", body: "Ship it on Friday", deletedAt: NOW };
        expect((await sweepDueReminders(NOW)).deleted).toBe(1);
        expect(alerts).toHaveLength(1);
        expect(alerts[0]!.title).toBe("notices.reminderDeleted");
        expect(alerts[0]!.body).toBeUndefined();
        expect(JSON.stringify(alerts[0])).not.toContain("Friday");
    });
});
