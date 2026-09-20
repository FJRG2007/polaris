/**
 * Send now: the rest of the undo window skipped, through the same queue.
 *
 * The hour moves to now and the timer is set for it, so the one conditional
 * claim in `deliverQueued` still decides who sends it - never a second path that
 * could send it twice. A message that is no longer queued (sent, or taken back)
 * has nothing to skip, and says so.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let queued = true;
const updates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        mailDraft: {
            findFirst: async () => ({ id: DRAFT }),
            updateMany: async (query: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
                updates.push(query);
                return { count: queued ? 1 : 0 };
            }
        }
    }
}));

vi.mock("@/lib/mailbox/live", () => ({ publishMail: () => undefined }));
vi.mock("@/lib/mailbox/sync", () => ({ refreshThreads: async () => undefined }));
vi.mock("@/lib/mailbox/prefs", () => ({ readMailPreferences: async () => ({}) }));
vi.mock("@/lib/mailbox/contacts", () => ({ rememberContacts: async () => undefined }));
vi.mock("@/lib/mailbox/credentials", () => ({
    MailAuthError: class MailAuthError extends Error {}
}));
vi.mock("@/lib/mailbox/uploads", () => ({
    readUpload: async () => null,
    attachUploads: async () => undefined
}));
vi.mock("@/lib/mailbox/access", () => ({
    ACCOUNT_COLUMNS: {},
    MailAccessError: class MailAccessError extends Error {},
    ownedAccount: async () => ({ id: "a1" })
}));
vi.mock("@/lib/mailbox/imap", () => ({ withImap: async () => undefined }));
vi.mock("@/lib/mailbox/send", () => ({
    composeMime: async () => ({ mime: Buffer.from(""), messageId: "sent-1@example.com" }),
    sendMime: async () => ({ accepted: ["them@example.net"], refused: [], response: "250 ok" })
}));

const DRAFT = "0198f0aa-0000-7000-8000-000000000001";
const compose = await import("@/lib/mailbox/compose");

beforeEach(() => {
    queued = true;
    updates.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00Z"));
});

afterEach(() => {
    vi.useRealTimers();
});

describe("send now", () => {
    it("moves a queued message's hour to now, and only a queued one", async () => {
        expect(await compose.sendNow("u1", DRAFT)).toBe(true);
        expect(updates[0]).toEqual({
            where: { id: DRAFT, state: "queued" },
            data: { sendAt: new Date("2026-09-19T10:00:00Z") }
        });
    });

    it("hands it to the queue's own claim at once", async () => {
        await compose.sendNow("u1", DRAFT);
        // Nothing yet: the timer is set, not run in the request.
        expect(updates).toHaveLength(1);
        queued = false;
        await vi.runOnlyPendingTimersAsync();
        // The claim - the same conditional move to `sending` the undo window's
        // own timer makes, which is what stops two of them sending it.
        expect(updates[1]?.where).toEqual({ id: DRAFT, state: "queued" });
        expect(updates[1]?.data).toMatchObject({ state: "sending" });
    });

    it("answers false when there is nothing left to skip", async () => {
        queued = false;
        expect(await compose.sendNow("u1", DRAFT)).toBe(false);
        await vi.runOnlyPendingTimersAsync();
        expect(updates).toHaveLength(1);
    });
});
