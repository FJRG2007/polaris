/**
 * A message somebody sends shows up in its own conversation as soon as the
 * outgoing server has taken it.
 *
 * The listener that makes new mail instant only watches the inbox, so the copy
 * in Sent used to wait for the next whole pass. A reply reached the person it
 * was for - and a mailbox copied on it, in this same Polaris - before it showed
 * up in the thread it was written in.
 *
 * What this pins: right after a send, Sent alone is read; a provider that files
 * its own copy (Gmail) is read again a few times until the message is there,
 * then left alone; and none of it holds up the send or can turn it into a
 * failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DRAFT = "0198f0aa-0000-7000-8000-000000000001";
const ACCOUNT = "0198f0aa-0000-7000-8000-000000000002";
const SENT = "0198f0aa-0000-7000-8000-000000000003";
const MESSAGE_ID = "sent-1@example.com";

const state = {
    draft: null as Record<string, unknown> | null,
    /** Whether Polaris files the copy itself; off is a provider that does. */
    appendToSent: false,
    hasSent: true,
    /** The read of Sent after which the copy is in it; 0 means never. */
    arrivesOnRead: 1,
    reads: [] as { accountId: string; folderId: string }[],
    lookups: [] as Record<string, unknown>[],
    /** What `syncFolderNow` does instead of resolving. */
    readHangs: false,
    readThrows: false
};

function draftRow(): Record<string, unknown> {
    return {
        id: DRAFT,
        accountId: ACCOUNT,
        state: "queued",
        failure: "",
        permanent: false,
        attempts: 0,
        sendAt: new Date("2026-09-19T10:00:00Z"),
        subject: "Re: Invoice for March",
        probe: false,
        body: "Thanks, paid.",
        replyTo: "",
        toJson: [{ name: "", address: "them@example.org" }],
        ccJson: [{ name: "", address: "copy@example.org" }],
        bccJson: [],
        inReplyToHeader: "",
        references: [],
        requestReceipt: false,
        identity: null,
        attachments: []
    };
}

vi.mock("@polaris/db", () => ({
    prisma: {
        mailDraft: {
            findUnique: async () => state.draft,
            updateMany: async () => {
                if (!state.draft || state.draft.state !== "queued") return { count: 0 };
                state.draft.state = "sending";
                return { count: 1 };
            },
            update: async ({ data }: { data: Record<string, unknown> }) => {
                if (state.draft) Object.assign(state.draft, data);
                return state.draft;
            },
            delete: async () => {
                state.draft = null;
                return {};
            },
            deleteMany: async () => {
                state.draft = null;
                return { count: 1 };
            }
        },
        mailAccount: {
            findUnique: async () => ({
                id: ACCOUNT,
                userId: "u1",
                address: "me@example.com",
                displayName: "",
                signature: "",
                signatureAboveQuote: true,
                signatureAuto: "never",
                appendToSent: state.appendToSent,
                user: { name: "Me" }
            })
        },
        mailFolder: {
            findFirst: async ({ where }: { where: { role?: string } }) =>
                where.role === "sent" && state.hasSent ? { id: SENT, path: "Sent" } : null
        },
        mailMessage: {
            updateMany: async () => ({ count: 0 }),
            findFirst: async ({ where }: { where: Record<string, unknown> }) => {
                state.lookups.push(where);
                const held = state.arrivesOnRead > 0 && state.reads.length >= state.arrivesOnRead;
                return held ? { id: "m1" } : null;
            }
        }
    }
}));

vi.mock("@/lib/mailbox/sync", () => ({
    refreshThreads: async () => undefined,
    syncFolderNow: (accountId: string, folderId: string) => {
        state.reads.push({ accountId, folderId });
        if (state.readThrows) return Promise.reject(new Error("socket closed"));
        if (state.readHangs) return new Promise<void>(() => undefined);
        return Promise.resolve();
    }
}));
vi.mock("@/lib/mailbox/live", () => ({ publishMail: () => undefined }));
vi.mock("@/lib/mailbox/prefs", () => ({ readMailPreferences: async () => ({ undoSeconds: 0 }) }));
vi.mock("@/lib/mailbox/contacts", () => ({ rememberContacts: async () => undefined }));
vi.mock("@/lib/mailbox/refused", () => ({ recordCredentialRefusal: async () => undefined }));
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
    ownedAccount: async () => ({ id: ACCOUNT })
}));
vi.mock("@/lib/mailbox/imap", () => ({ withImap: async () => undefined }));
vi.mock("@/lib/mailbox/delivery", () => ({
    recordSend: async () => "d1",
    recordSentCopy: async () => undefined,
    announceUnsent: async () => undefined,
    announcePartial: async () => undefined
}));
vi.mock("@/lib/mailbox/send", () => ({
    MailRejectedError: class MailRejectedError extends Error {},
    composeMime: async () => ({ mime: Buffer.from(""), messageId: MESSAGE_ID }),
    sendMime: async () => ({ accepted: ["them@example.org"], refused: [], response: "250 ok" })
}));

const compose = await import("@/lib/mailbox/compose");

/** Lets every background step and every pause between reads run out. */
async function settle(): Promise<void> {
    for (let round = 0; round < 20; round += 1) await vi.runOnlyPendingTimersAsync();
}

beforeEach(() => {
    state.draft = draftRow();
    state.appendToSent = false;
    state.hasSent = true;
    state.arrivesOnRead = 1;
    state.reads.length = 0;
    state.lookups.length = 0;
    state.readHangs = false;
    state.readThrows = false;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00Z"));
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe("a sent message in its thread", () => {
    it("reads Sent right after the send, and stops once the message is there", async () => {
        expect(await compose.deliverQueued(DRAFT)).toBe(true);
        await settle();
        expect(state.reads).toEqual([{ accountId: ACCOUNT, folderId: SENT }]);
        expect(state.lookups[0]).toEqual({
            accountId: ACCOUNT,
            folderId: SENT,
            messageId: MESSAGE_ID
        });
    });

    it("reads again while a provider that files its own copy has not yet", async () => {
        state.arrivesOnRead = 3;
        await compose.deliverQueued(DRAFT);
        await settle();
        expect(state.reads).toHaveLength(3);
    });

    it("gives up after a few reads, leaving it to the ordinary passes", async () => {
        state.arrivesOnRead = 0;
        await compose.deliverQueued(DRAFT);
        await settle();
        expect(state.reads).toHaveLength(compose.SENT_COPY_READS_MS.length);
    });

    it("reads the copy Polaris filed itself, once", async () => {
        state.appendToSent = true;
        await compose.deliverQueued(DRAFT);
        await settle();
        expect(state.reads).toHaveLength(1);
    });

    it("does not look for a copy that was never filed", async () => {
        state.appendToSent = true;
        state.hasSent = false;
        await compose.deliverQueued(DRAFT);
        await settle();
        expect(state.reads).toHaveLength(0);
    });

    it("never holds up the send", async () => {
        state.readHangs = true;
        expect(await compose.deliverQueued(DRAFT)).toBe(true);
        expect(state.draft).toBeNull();
    });

    it("never turns a send into a failure when Sent cannot be read", async () => {
        state.readThrows = true;
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        expect(await compose.deliverQueued(DRAFT)).toBe(true);
        await settle();
        expect(state.reads).toHaveLength(1);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
