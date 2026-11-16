/**
 * A reminder on a message that is gone for its reader says nothing: expired by
 * the timer, deleted by them for themselves, or before they cleared the chat.
 * Run against the real visibility module, not a stand-in for it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { matches, type StoredMessage } from "./support/message-store";

const NOW = new Date("2026-11-16T12:00:00Z");
let stored: StoredMessage;
let clearedAt: Date | null = null;
let alerts: string[] = [];

function message(extra: Partial<StoredMessage> = {}): StoredMessage {
    return {
        id: "m1",
        channelId: "c1",
        createdAt: new Date("2026-11-16T10:00:00Z"),
        expiresAt: null,
        parentId: null,
        hiddenFor: [],
        ...extra
    };
}

vi.mock("@/lib/chat/access", () => ({
    ChatAccessError: class extends Error {},
    channelAccess: async () => ({ channelId: "c1" }),
    requireChannel: async () => ({ channelId: "c1" }),
    reachableChannelIds: async () => new Set(["c1"])
}));
vi.mock("@/lib/chat/text", () => ({ chatWordsFor: async () => (key: string) => key }));
vi.mock("@/lib/chat/isolation", () => ({ chatAlertShelf: async () => undefined }));
vi.mock("@/lib/notifications/dispatch", () => ({
    notify: async (input: { title: string }) => {
        alerts.push(input.title);
        return { inapp: "created" };
    }
}));
vi.mock("@/components/rich-text/excerpt", () => ({ plainExcerpt: (body: string) => body }));
vi.mock("@polaris/db", () => ({
    prisma: {
        chatReminder: {
            deleteMany: async () => ({ count: 0 }),
            findMany: async () => [{ id: "r1", userId: "grace", messageId: "m1" }],
            updateMany: async () => ({ count: 1 })
        },
        chatMessage: {
            findUnique: async () => ({
                channelId: "c1",
                body: "Call the plumber",
                deletedAt: null,
                channel: { orgId: null, space: null }
            }),
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
                matches(stored, where) ? stored : null
        },
        // The history floor: no space channel closes history here, and the
        // reader's own clear is the only floor.
        chatChannel: { findMany: async () => [] },
        chatChannelMember: {
            findMany: async () => (clearedAt ? [{ channelId: "c1", clearedAt }] : [])
        }
    }
}));

const { sweepDueReminders } = await import("@/lib/chat/reminders");

beforeEach(() => {
    stored = message();
    clearedAt = null;
    alerts = [];
});

describe("a reminder on a disappearing message", () => {
    it("fires on a message the reader can still read", async () => {
        const counts = await sweepDueReminders(NOW);
        expect(counts.sent).toBe(1);
        expect(alerts).toEqual(["notices.reminder"]);
    });
    it("says nothing once the message expired", async () => {
        stored = message({ expiresAt: new Date("2026-11-16T11:00:00Z") });
        const counts = await sweepDueReminders(NOW);
        expect(counts.unreadable).toBe(1);
        expect(alerts).toEqual([]);
    });
    it("says nothing once the reader deleted it for themselves", async () => {
        stored = message({ hiddenFor: ["grace"] });
        expect((await sweepDueReminders(NOW)).unreadable).toBe(1);
        expect(alerts).toEqual([]);
    });
    it("says nothing for a message from before they cleared the chat", async () => {
        clearedAt = new Date("2026-11-16T11:00:00Z");
        expect((await sweepDueReminders(NOW)).unreadable).toBe(1);
        expect(alerts).toEqual([]);
    });
});
