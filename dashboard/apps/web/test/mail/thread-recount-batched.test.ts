/**
 * Recounting an account's conversations after a sync page.
 *
 * It ran a read and a write per conversation - a thousand round trips for a
 * mailbox of five hundred, after every page stored - and rewrote every row
 * with what it already held. Now it is one read of the conversations, one of
 * their messages, a write only where something changed and one delete for the
 * conversations left empty.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 10, minute));
const ADA = { address: "ada@example.test", name: "Ada" };

const db = vi.hoisted(() => ({
    threads: [] as Record<string, unknown>[],
    messages: [] as Record<string, unknown>[],
    calls: [] as string[],
    updated: [] as { id: string; data: Record<string, unknown> }[],
    deleted: [] as string[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        mailThread: {
            findMany: async () => {
                db.calls.push("threads");
                return db.threads;
            },
            update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
                db.calls.push("update");
                db.updated.push({ id: where.id, data });
                return {};
            },
            delete: async () => {
                db.calls.push("delete");
                return {};
            },
            deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
                db.calls.push("deleteMany");
                db.deleted.push(...where.id.in);
                return { count: where.id.in.length };
            }
        },
        mailMessage: {
            findMany: async ({ where }: { where: { threadId: string | { in: string[] } } }) => {
                db.calls.push("messages");
                const ids = typeof where.threadId === "string" ? [where.threadId] : where.threadId.in;
                return db.messages.filter((row) => ids.includes(row.threadId as string));
            }
        }
    }
}));

vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));

const { refreshThreads } = await import("@/lib/mailbox/sync");
const core = await import("@polaris/core");
const { addressesFrom } = await import("@/lib/mailbox/json");

function message(threadId: string, minute: number, seen: boolean) {
    return {
        threadId,
        seen,
        flagged: false,
        important: false,
        sentAt: at(minute),
        snippet: `snippet ${minute}`,
        subject: "Hello",
        fromJson: [ADA],
        toJson: [],
        hasAttachments: false,
        size: 10
    };
}

beforeEach(() => {
    db.calls = [];
    db.updated = [];
    db.deleted = [];
    db.messages = [
        message("current", 1, true),
        message("current", 2, true),
        message("stale", 3, true),
        message("stale", 4, false)
    ];
    const settled = {
        subject: "Hello",
        // What a recount stores for these messages.
        participants: core.dedupeAddresses(addressesFrom([ADA])),
        messageCount: 2,
        unreadCount: 0,
        starred: false,
        important: false,
        hasAttachments: false,
        size: 20
    };
    db.threads = [
        { id: "current", ...settled, snippet: "snippet 2", firstMessageAt: at(1), lastMessageAt: at(2) },
        // A new unread reply arrived: the count and the snippet are behind.
        { id: "stale", ...settled, snippet: "snippet 3", firstMessageAt: at(3), lastMessageAt: at(3) },
        { id: "empty", ...settled, snippet: "", firstMessageAt: at(0), lastMessageAt: at(0) }
    ];
});

describe("refreshThreads", () => {
    it("reads once, writes only what changed and deletes the empty in one go", async () => {
        await refreshThreads("account-1");
        expect(db.calls).toEqual(["threads", "messages", "update", "deleteMany"]);
        expect(db.updated).toHaveLength(1);
        expect(db.updated[0]).toMatchObject({
            id: "stale",
            data: { unreadCount: 1, messageCount: 2, snippet: "snippet 4", lastMessageAt: at(4) }
        });
        expect(db.deleted).toEqual(["empty"]);
    });
});
