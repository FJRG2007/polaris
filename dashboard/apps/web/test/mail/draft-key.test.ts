/**
 * A draft a device kept offline is one draft, however many times it is saved:
 * the first save with the composer's key creates it, every later one writes
 * over that same draft, one still being created asks for a moment, and a
 * draft that went on to be sent is never put back to being a draft.
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

const state = {
    keys: new Map<string, KeyRow>(),
    drafts: 0,
    updates: [] as string[],
    draftState: "draft",
    refuseCreate: false
};

class MailAccessError extends Error {}

vi.mock("@polaris/db", () => ({
    prisma: {
        mailSendKey: {
            deleteMany: async () => ({ count: 0 }),
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
                if (state.refuseCreate) throw new Error("database down");
                state.drafts += 1;
                return { id: DRAFT };
            },
            update: async ({ data }: { data: { body: string } }) => {
                state.updates.push(data.body);
                return { id: DRAFT };
            },
            findFirst: async ({ where }: { where: { id: string } }) => (where.id === DRAFT ? { id: DRAFT } : null),
            findUnique: async () => ({ state: state.draftState })
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

const { saveDraftOnce, SendInProgressError } = await import("@/lib/mailbox/compose");

const input = (body: string, draftId: string | null = null) => ({
    accountId: ACCOUNT,
    identityId: null,
    to: [{ name: "", address: "ana@example.com" }],
    cc: [],
    bcc: [],
    replyTo: "",
    subject: "Hi",
    body,
    attachmentIds: [],
    inReplyToId: null,
    forward: false,
    sendAt: null,
    requestReceipt: false,
    draftId
});

beforeEach(() => {
    state.keys.clear();
    state.drafts = 0;
    state.updates = [];
    state.draftState = "draft";
    state.refuseCreate = false;
});

describe("a kept draft saved again", () => {
    it("is created once, and every later save writes over that same draft", async () => {
        expect(await saveDraftOnce("u1", input("first"), KEY)).toBe(DRAFT);
        expect(await saveDraftOnce("u1", input("newer"), KEY)).toBe(DRAFT);
        expect(state.drafts).toBe(1);
        expect(state.updates).toEqual(["newer"]);
    });

    it("asks for a moment while its first save is still being taken", async () => {
        state.keys.set(KEY, { key: KEY, userId: "u1", draftId: null, sendAt: null, expiresAt: new Date(Date.now() + 1e6) });
        await expect(saveDraftOnce("u1", input("x"), KEY)).rejects.toBeInstanceOf(SendInProgressError);
        expect(state.drafts).toBe(0);
    });

    it("never puts a message that went on to be sent back to being a draft", async () => {
        await saveDraftOnce("u1", input("first"), KEY);
        state.draftState = "queued";
        expect(await saveDraftOnce("u1", input("older copy"), KEY)).toBe(DRAFT);
        expect(await saveDraftOnce("u1", input("older copy", DRAFT), KEY)).toBe(DRAFT);
        expect(state.updates).toEqual([]);
    });

    it("answers somebody else's key as a draft that is not there", async () => {
        await saveDraftOnce("u1", input("first"), KEY);
        await expect(saveDraftOnce("u2", input("x"), KEY)).rejects.toBeInstanceOf(MailAccessError);
    });

    it("frees the key when the first save fails, so the next one starts over", async () => {
        state.refuseCreate = true;
        await expect(saveDraftOnce("u1", input("x"), KEY)).rejects.toThrow();
        expect(state.keys.has(KEY)).toBe(false);
        state.refuseCreate = false;
        expect(await saveDraftOnce("u1", input("x"), KEY)).toBe(DRAFT);
        expect(state.drafts).toBe(1);
    });
});
