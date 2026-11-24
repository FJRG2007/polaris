/**
 * A send a device kept offline goes once, however many times it is replayed:
 * the first attempt with its key queues it, every later one is answered with
 * what the first was queued as, one still being taken asks for a moment, and a
 * first attempt that fails leaves the key free for the next.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "0198f0aa-0000-7000-8000-000000000001";
const ACCOUNT = "0198f0aa-0000-7000-8000-0000000000aa";
const DRAFT = "0198f0aa-0000-7000-8000-0000000000d2";

interface KeyRow {
    key: string;
    userId: string;
    draftId: string | null;
    sendAt: Date | null;
    expiresAt: Date;
}

const state = { keys: new Map<string, KeyRow>(), drafts: 0, refuseAccount: false };

class MailAccessError extends Error {}

vi.mock("@polaris/db", () => ({
    prisma: {
        mailSendKey: {
            deleteMany: async ({ where }: { where: { expiresAt: { lt: Date } } }) => {
                for (const [key, row] of state.keys) if (row.expiresAt < where.expiresAt.lt) state.keys.delete(key);
                return { count: 0 };
            },
            create: async ({ data }: { data: Omit<KeyRow, "draftId" | "sendAt"> }) => {
                if (state.keys.has(data.key)) throw Object.assign(new Error("unique"), { code: "P2002" });
                state.keys.set(data.key, { ...data, draftId: null, sendAt: null });
                return data;
            },
            findUnique: async ({ where }: { where: { key: string } }) => state.keys.get(where.key) ?? null,
            update: async ({ where, data }: { where: { key: string }; data: Partial<KeyRow> }) =>
                Object.assign(state.keys.get(where.key)!, data),
            delete: async ({ where }: { where: { key: string } }) => state.keys.delete(where.key)
        },
        mailDraft: {
            create: async () => {
                state.drafts += 1;
                return { id: DRAFT };
            },
            update: async () => ({ id: DRAFT })
        }
    }
}));
vi.mock("@/lib/mailbox/access", () => ({
    ACCOUNT_COLUMNS: {},
    MailAccessError,
    ownedAccount: async () => {
        if (state.refuseAccount) throw new MailAccessError("That mailbox is not yours.");
        return { id: ACCOUNT };
    }
}));
vi.mock("@/lib/mailbox/uploads", () => ({
    attachUploads: async () => undefined,
    readUpload: async () => null,
    releaseDraftUploads: async () => undefined
}));
vi.mock("@/lib/mailbox/prefs", () => ({ readMailPreferences: async () => ({ undoSeconds: 10 }) }));
vi.mock("@/lib/mailbox/live", () => ({ publishMail: () => undefined }));
vi.mock("@/lib/mailbox/sync", () => ({ refreshThreads: async () => undefined, syncFolderNow: async () => undefined }));
vi.mock("@/lib/mailbox/contacts", () => ({ rememberContacts: async () => undefined }));
vi.mock("@/lib/mailbox/refused", () => ({ recordCredentialRefusal: async () => undefined }));
vi.mock("@/lib/mailbox/credentials", () => ({ MailAuthError: class MailAuthError extends Error {} }));
vi.mock("@/lib/mailbox/imap", () => ({ withImap: async () => undefined }));
vi.mock("@/lib/mailbox/send", () => ({
    MailRejectedError: class MailRejectedError extends Error {},
    composeMime: async () => "",
    sendMime: async () => undefined
}));

const { queueSendOnce, SendInProgressError } = await import("@/lib/mailbox/compose");

// An hour away, so no timer is set for it in the test.
const SEND_AT = new Date(Date.now() + 3_600_000);
const input = {
    accountId: ACCOUNT,
    identityId: null,
    to: [{ name: "", address: "ana@example.com" }],
    cc: [],
    bcc: [],
    replyTo: "",
    subject: "Hi",
    body: "Hello",
    attachmentIds: [],
    inReplyToId: null,
    forward: false,
    sendAt: SEND_AT,
    requestReceipt: false,
    draftId: null,
    reaction: ""
};

beforeEach(() => {
    state.keys.clear();
    state.drafts = 0;
    state.refuseAccount = false;
});

describe("a kept send replayed", () => {
    it("is queued once, and answered with the same draft every time after", async () => {
        const first = await queueSendOnce("u1", input, KEY);
        const again = await queueSendOnce("u1", input, KEY);
        expect(first).toEqual({ draftId: DRAFT, sendAt: SEND_AT });
        expect(again).toEqual(first);
        expect(state.drafts).toBe(1);
    });

    it("asks for a moment while its first attempt is still being taken", async () => {
        state.keys.set(KEY, { key: KEY, userId: "u1", draftId: null, sendAt: null, expiresAt: new Date(Date.now() + 1e6) });
        await expect(queueSendOnce("u1", input, KEY)).rejects.toBeInstanceOf(SendInProgressError);
        expect(state.drafts).toBe(0);
    });

    it("answers somebody else's key as a message that is not there", async () => {
        await queueSendOnce("u1", input, KEY);
        await expect(queueSendOnce("u2", input, KEY)).rejects.toBeInstanceOf(MailAccessError);
    });

    it("frees the key when the first attempt is refused, so the next one is taken", async () => {
        state.refuseAccount = true;
        await expect(queueSendOnce("u1", input, KEY)).rejects.toBeInstanceOf(MailAccessError);
        expect(state.keys.has(KEY)).toBe(false);
        state.refuseAccount = false;
        expect(await queueSendOnce("u1", input, KEY)).toEqual({ draftId: DRAFT, sendAt: SEND_AT });
    });

    it("forgets keys whose time is up", async () => {
        state.keys.set("old", { key: "old", userId: "u1", draftId: DRAFT, sendAt: SEND_AT, expiresAt: new Date(0) });
        await queueSendOnce("u1", input, KEY);
        expect(state.keys.has("old")).toBe(false);
    });
});
