/**
 * A draft's copy in the mail server's Drafts folder, and sending once.
 *
 * The copy is found again by its Message-Id and never by a uid that may have
 * moved to somebody else's message; it is written with the Draft flag and keeps
 * its blind copies, which a sent message never does; it goes when the draft is
 * sent or thrown away. And once the outgoing server has taken a message, nothing
 * that fails afterwards may put it back in the queue to be sent again.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let appended: { path: string; mime: string; flags: string[] } | null = null;
let draftState = "draft";
let lastDraftUpdate: Record<string, unknown> | null = null;
let failAfterSend = false;
let draftDeleted = 0;

const draftRow = {
    id: "0198f0aa-0000-7000-8000-000000000001",
    accountId: "a1",
    subject: "Plans",
    body: "Hello",
    replyTo: "",
    toJson: [{ name: "", address: "ana@example.com" }],
    ccJson: [],
    bccJson: [{ name: "", address: "hidden@example.com" }],
    inReplyToHeader: "",
    references: [],
    requestReceipt: false,
    identity: null,
    attachments: [],
    // What discarding reads alongside the draft: the mailbox to reach.
    account: { id: "a1" }
};

vi.mock("@polaris/db", () => ({
    prisma: {
        mailDraft: {
            findFirst: async () => (draftState === "draft" ? draftRow : null),
            findUnique: async () => draftRow,
            updateMany: async () => ({ count: 1 }),
            update: async (query: { data: Record<string, unknown> }) => {
                lastDraftUpdate = query.data;
                return {};
            },
            delete: async () => {
                draftDeleted += 1;
                if (failAfterSend) throw new Error("the database went away");
                return {};
            },
            deleteMany: async () => {
                draftDeleted += 1;
                return { count: 1 };
            }
        },
        mailAccount: {
            findUnique: async () => ({
                id: "a1",
                userId: "u1",
                address: "me@example.com",
                displayName: "Me",
                signature: "",
                signatureAboveQuote: true,
                signatureAuto: "never",
                appendToSent: false,
                user: { name: "Me" }
            })
        },
        mailFolder: { findFirst: async () => ({ path: "Drafts" }) },
        mailMessage: { updateMany: async () => ({ count: 0 }) }
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

/** A mail server that records what it is asked. */
const client = {
    getMailboxLock: async (path: string) => {
        calls.push(`lock ${path}`);
        return { release: () => calls.push("release") };
    },
    search: async (query: { header: Record<string, string> }) => {
        calls.push(`search ${query.header["message-id"]}`);
        return [41];
    },
    messageDelete: async (uids: number[]) => {
        calls.push(`delete ${uids.join(",")}`);
        return true;
    },
    append: async (path: string, mime: Buffer, flags: string[]) => {
        appended = { path, mime: mime.toString("utf8"), flags };
        return { uid: 42 };
    }
};
vi.mock("@/lib/mailbox/imap", () => ({
    withImap: async (_account: unknown, run: (held: typeof client) => unknown) => run(client)
}));

let sentMime = "";
vi.mock("@/lib/mailbox/send", async () => {
    const real = await vi.importActual<typeof import("@/lib/mailbox/send")>("@/lib/mailbox/send");
    return {
        composeMime: real.composeMime,
        sendMime: async (_account: unknown, _message: unknown, mime: Buffer) => {
            sentMime = mime.toString("utf8");
        }
    };
});

const compose = await import("@/lib/mailbox/compose");
const { polarisDraftMessageId, isPolarisDraftMessageId } = await import("@polaris/core");

beforeEach(() => {
    calls.length = 0;
    appended = null;
    draftState = "draft";
    lastDraftUpdate = null;
    failAfterSend = false;
    draftDeleted = 0;
    sentMime = "";
});

describe("the copy in Drafts", () => {
    it("replaces the last copy, found by its Message-Id, and is flagged as a draft", async () => {
        await compose.fileDraftOnServer("u1", draftRow.id);
        const id = polarisDraftMessageId(draftRow.id);
        expect(calls).toEqual(["lock Drafts", `search ${id}`, "delete 41", "release"]);
        expect(appended?.path).toBe("Drafts");
        expect(appended?.flags).toEqual(["\\Draft", "\\Seen"]);
        // Unfolded first: a long header is folded onto a second line, and IMAP
        // SEARCH matches the unfolded value.
        expect(appended?.mime.replace(/\r\n[ \t]+/g, " ")).toContain(`Message-ID: <${id}>`);
        // Kept on the copy, so it can be finished elsewhere without losing them.
        expect(appended?.mime).toContain("hidden@example.com");
        expect(lastDraftUpdate).toEqual({ serverUid: 42n });
    });

    it("leaves a message waiting to go to the queue", async () => {
        draftState = "queued";
        await compose.fileDraftOnServer("u1", draftRow.id);
        expect(appended).toBeNull();
    });

    it("goes when the draft is thrown away", async () => {
        await compose.discardDraft("u1", draftRow.id);
        expect(calls).toContain(`search ${polarisDraftMessageId(draftRow.id)}`);
        expect(calls).toContain("delete 41");
    });

    it("is recognised by sync, and nothing else is", () => {
        expect(isPolarisDraftMessageId(`<${polarisDraftMessageId(draftRow.id)}>`)).toBe(true);
        expect(isPolarisDraftMessageId("<CAB12@mail.gmail.com>")).toBe(false);
    });
});

describe("sending", () => {
    it("never writes the blind copies into what is sent", async () => {
        expect(await compose.deliverQueued(draftRow.id)).toBe(true);
        expect(sentMime).not.toContain("hidden@example.com");
    });

    it("does not put a sent message back in the queue when tidying up after it fails", async () => {
        failAfterSend = true;
        expect(await compose.deliverQueued(draftRow.id)).toBe(true);
        // The failed tidy-up did not mark it failed; the queue entry still went.
        expect(lastDraftUpdate?.state).toBeUndefined();
        expect(draftDeleted).toBe(2);
    });
});
