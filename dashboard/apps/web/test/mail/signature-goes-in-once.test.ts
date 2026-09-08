/**
 * A signature goes in once.
 *
 * The composer puts it into the body as somebody writes, which is what makes it
 * a thing they can see, move and delete. The send path also knows how to add
 * one, because a draft can reach the queue without ever passing through the
 * composer. Both are right; both running is the classic way this feature ships,
 * and what it looks like is every message from a mailbox with a signature
 * carrying two of them.
 *
 * So the send path is the backstop, and this pins that it behaves like one: it
 * leaves a body that already carries the two-hyphen line alone, and it obeys the
 * mailbox's own answer to when a signature goes in unasked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface AccountRow {
    signature: string;
    signatureAboveQuote: boolean;
    signatureAuto: string;
}

let account: AccountRow;
let draft: { body: string; inReplyToHeader: string | null };

/** The body the message actually went out with. */
let sent = "";

vi.mock("@polaris/db", () => ({
    prisma: {
        mailDraft: {
            updateMany: async () => ({ count: 1 }),
            findUnique: async () => ({
                id: "d1",
                accountId: "a1",
                subject: "Hello",
                body: draft.body,
                replyTo: "",
                toJson: [{ address: "them@example.test" }],
                ccJson: [],
                bccJson: [],
                inReplyToHeader: draft.inReplyToHeader,
                references: [],
                requestReceipt: false,
                identity: null,
                attachments: []
            }),
            update: async () => ({}),
            delete: async () => ({})
        },
        mailAccount: {
            findUnique: async () => ({
                id: "a1",
                userId: "u1",
                address: "me@example.test",
                displayName: "Me",
                user: { name: "Me" },
                ...account
            })
        },
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
vi.mock("@/lib/mailbox/imap", () => ({ withImap: async () => undefined }));
vi.mock("@/lib/mailbox/send", () => ({
    composeMime: async (message: { body: string }) => {
        sent = message.body;
        return Buffer.from("");
    },
    sendMime: async () => undefined
}));
vi.mock("@/lib/mailbox/access", () => ({
    ACCOUNT_COLUMNS: {},
    MailAccessError: class MailAccessError extends Error {},
    ownedAccount: async () => ({ id: "a1" })
}));

const { deliverQueued } = await import("@/lib/mailbox/compose");

/** The signature as every client writes it: two hyphens, a space, a newline. */
const BLOCK = "-- \nMe, Example Ltd";

beforeEach(() => {
    sent = "";
    account = { signature: "Me, Example Ltd", signatureAboveQuote: true, signatureAuto: "new" };
    draft = { body: "Morning.", inReplyToHeader: null };
});

describe("a body the composer already signed", () => {
    it("goes out with the one signature that is in it", async () => {
        draft.body = `Morning.\n\n${BLOCK}`;
        expect(await deliverQueued("d1")).toBe(true);
        expect(sent).toBe(`Morning.\n\n${BLOCK}`);
        // The whole of the bug: the signature must appear once.
        expect(sent.split("-- ").length - 1).toBe(1);
    });

    it("is recognised even when the trailing space was eaten in transit", async () => {
        draft.body = "Morning.\n\n--\nMe, Example Ltd";
        await deliverQueued("d1");
        expect(sent).toBe("Morning.\n\n--\nMe, Example Ltd");
    });
});

describe("what the mailbox asked for", () => {
    it("adds nothing when the answer is only when I insert it", async () => {
        account.signatureAuto = "never";
        await deliverQueued("d1");
        expect(sent).toBe("Morning.");
    });

    it("adds nothing to a reply when the answer is on messages I start", async () => {
        draft.inReplyToHeader = "<earlier@example.test>";
        await deliverQueued("d1");
        expect(sent).toBe("Morning.");
    });

    it("signs a reply when the answer is on everything", async () => {
        account.signatureAuto = "always";
        draft.inReplyToHeader = "<earlier@example.test>";
        await deliverQueued("d1");
        expect(sent).toContain(BLOCK);
    });

    it("still signs a message nothing else signed, which is what it is for", async () => {
        await deliverQueued("d1");
        expect(sent).toBe(`Morning.\n\n${BLOCK}`);
    });

    it("puts it above the quoted history when that is what the mailbox says", async () => {
        account.signatureAuto = "always";
        draft.inReplyToHeader = "<earlier@example.test>";
        draft.body = "Morning.\n\nOn Monday, they wrote:\n> Hello";
        await deliverQueued("d1");
        expect(sent.indexOf(BLOCK)).toBeLessThan(sent.indexOf("> Hello"));
    });
});
