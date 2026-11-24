/**
 * The headers a reply carries so that it threads, in Polaris and elsewhere.
 *
 * In-Reply-To names the message answered; References is the parent's chain with
 * the parent last. A parent that has no References but answered one message
 * stands that message in for the chain (RFC 5322 3.6.4).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let parent: { messageId: string; references: string[]; inReplyTo: string } | null = null;
let written: Record<string, unknown> | null = null;

vi.mock("@polaris/db", () => ({
    prisma: {
        mailMessage: { findFirst: async () => parent },
        mailDraft: {
            create: async (query: { data: Record<string, unknown> }) => {
                written = query.data;
                return { id: "d1" };
            }
        }
    }
}));
vi.mock("@/lib/mailbox/live", () => ({ publishMail: () => undefined }));
vi.mock("@/lib/mailbox/sync", () => ({
    refreshThreads: async () => undefined,
    syncFolderNow: async () => undefined
}));
vi.mock("@/lib/mailbox/prefs", () => ({ readMailPreferences: async () => ({}) }));
vi.mock("@/lib/mailbox/contacts", () => ({ rememberContacts: async () => undefined }));
vi.mock("@/lib/mailbox/credentials", () => ({
    MailAuthError: class MailAuthError extends Error {}
}));
vi.mock("@/lib/mailbox/uploads", () => ({
    readUpload: async () => null,
    attachUploads: async () => undefined,
    releaseDraftUploads: async () => 0
}));
vi.mock("@/lib/mailbox/access", () => ({
    ACCOUNT_COLUMNS: {},
    MailAccessError: class MailAccessError extends Error {},
    ownedAccount: async () => ({ id: "a1" })
}));
vi.mock("@/lib/mailbox/imap", () => ({ withImap: async () => undefined }));

const { saveDraft } = await import("@/lib/mailbox/compose");

const reply = {
    accountId: "a1",
    identityId: null,
    to: [{ name: "", address: "ana@example.com" }],
    cc: [],
    bcc: [],
    replyTo: "",
    subject: "Re: Plans",
    body: "Yes",
    attachmentIds: [],
    inReplyToId: "0198f0aa-0000-7000-8000-000000000009",
    forward: false,
    sendAt: null,
    requestReceipt: false,
    draftId: null
};

describe("reply threading headers", () => {
    beforeEach(() => {
        written = null;
    });

    it("carries the parent's whole chain with the parent last", async () => {
        parent = { messageId: "c@x", references: ["<a@x>", "b@x"], inReplyTo: "b@x" };
        await saveDraft("u1", reply);
        expect(written?.inReplyToHeader).toBe("<c@x>");
        expect(written?.references).toEqual(["<a@x>", "<b@x>", "<c@x>"]);
    });

    it("stands the parent's In-Reply-To in for a References it never had", async () => {
        parent = { messageId: "c@x", references: [], inReplyTo: "<b@x>" };
        await saveDraft("u1", reply);
        expect(written?.references).toEqual(["<b@x>", "<c@x>"]);
    });

    it("starts the chain at the parent when it answered nothing", async () => {
        parent = { messageId: "c@x", references: [], inReplyTo: "" };
        await saveDraft("u1", reply);
        expect(written?.references).toEqual(["<c@x>"]);
    });

    it("keeps what it answers on a draft saved before it is sent", async () => {
        parent = { messageId: "c@x", references: [], inReplyTo: "" };
        await saveDraft("u1", reply);
        expect(written?.inReplyToId).toBe(reply.inReplyToId);
    });
});
