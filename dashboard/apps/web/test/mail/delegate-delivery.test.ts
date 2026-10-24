/**
 * A delegate's message, through the real queue (`deliverQueued`): the grant is
 * asked again at the moment it goes, so taking it back stops it; it goes on the
 * holder's behalf with the delegate in `Sender:` unless the holder chose "send
 * as"; a grant that cannot be checked leaves it to be tried again rather than
 * stuck; a refusal is told to whoever wrote it; and the holder and the
 * delegate never reach each other's drafts.
 */

import * as core from "@polaris/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DRAFT = "0198f0aa-0000-7000-8000-0000000000e1";
const ACCOUNT = "0198f0aa-0000-7000-8000-0000000000e2";

interface DraftRow {
    id: string;
    accountId: string;
    authorId: string | null;
    state: string;
    failure: string;
    permanent: boolean;
    attempts: number;
    sendAt: Date | null;
    subject: string;
    probe: boolean;
    body: string;
    replyTo: string;
    toJson: unknown[];
    ccJson: unknown[];
    bccJson: unknown[];
    inReplyToHeader: string;
    references: unknown[];
    requestReceipt: boolean;
    identity: null;
    attachments: never[];
}

const state = {
    draft: null as DraftRow | null,
    sendAs: false,
    capability: "respond" as string,
    grantsThrow: null as unknown,
    sendThrows: null as unknown,
    sent: [] as { sender?: core.MailAddress; from: core.MailAddress }[],
    used: [] as Record<string, unknown>[],
    unsent: [] as (string | null)[]
};

function draftRow(over: Partial<DraftRow> = {}): DraftRow {
    return {
        id: DRAFT,
        accountId: ACCOUNT,
        authorId: "delegate",
        state: "queued",
        failure: "",
        permanent: false,
        attempts: 0,
        sendAt: new Date("2026-09-19T10:00:00Z"),
        subject: "Re: Plans",
        probe: false,
        body: "Yes",
        replyTo: "",
        toJson: [{ name: "", address: "ana@example.test" }],
        ccJson: [],
        bccJson: [],
        inReplyToHeader: "",
        references: [],
        requestReceipt: false,
        identity: null,
        attachments: [],
        ...over
    };
}

vi.mock("@polaris/db", () => ({
    prisma: {
        mailDraft: {
            findFirst: async ({ where }: { where: { id: string; authorId?: string | null } }) => {
                const row = state.draft;
                if (!row || row.id !== where.id) return null;
                if ("authorId" in where && row.authorId !== where.authorId) return null;
                return { id: row.id };
            },
            findUnique: async () => state.draft,
            updateMany: async ({
                where,
                data
            }: {
                where: Record<string, unknown>;
                data: Record<string, unknown>;
            }) => {
                const row = state.draft;
                if (!row || row.id !== where.id) return { count: 0 };
                if (typeof where.state === "string" && row.state !== where.state)
                    return { count: 0 };
                const { attempts, ...plain } = data as {
                    attempts?: number | { increment?: number };
                };
                Object.assign(row, plain);
                if (typeof attempts === "number") row.attempts = attempts;
                else if (attempts?.increment) row.attempts += attempts.increment;
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
                userId: "holder",
                address: "boss@example.test",
                displayName: "Boss",
                signature: "",
                signatureAboveQuote: true,
                signatureAuto: "never",
                appendToSent: false,
                delegateSendAs: state.sendAs,
                user: { name: "Boss" }
            }),
            findFirst: async ({ where }: { where: { id: string } }) =>
                where.id === ACCOUNT ? { userId: "holder" } : null
        },
        user: {
            findUnique: async () => ({ name: "Helper", email: "helper@example.test" })
        },
        mailFolder: { findFirst: async () => null },
        mailMessage: { updateMany: async () => ({ count: 0 }) }
    }
}));

vi.mock("@/lib/access/grants", () => ({
    liveGrants: async () => {
        if (state.grantsThrow) throw state.grantsThrow;
        return state.capability ? [{ id: "grant-1", capability: state.capability }] : [];
    },
    grantedCapability: async () => state.capability,
    grantedSubjects: async () => new Map(),
    recordGrantUse: async (use: Record<string, unknown>) => {
        state.used.push(use);
    }
}));
vi.mock("@/lib/mailbox/live", () => ({ publishMail: () => undefined }));
vi.mock("@/lib/mailbox/sync", () => ({ refreshThreads: async () => undefined }));
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
vi.mock("@/lib/mailbox/imap", () => ({ withImap: async () => undefined }));
vi.mock("@/lib/mailbox/delivery", () => ({
    recordSend: async () => "d1",
    recordSentCopy: async () => undefined,
    announceUnsent: async (
        _id: string,
        _subject: string,
        _detail: string,
        authorId: string | null
    ) => {
        state.unsent.push(authorId);
    },
    announcePartial: async () => undefined
}));
vi.mock("@/lib/mailbox/send", () => ({
    MailRejectedError: class MailRejectedError extends Error {
        public failure: core.MailSendFailure;
        public constructor(failure: core.MailSendFailure) {
            super(core.sendFailureSentence(failure));
            this.failure = failure;
        }
    },
    composeMime: async () => ({ mime: Buffer.from(""), messageId: "sent-1@example.test" }),
    sendMime: async (
        _account: unknown,
        message: { sender?: core.MailAddress; from: core.MailAddress }
    ) => {
        if (state.sendThrows) throw state.sendThrows;
        state.sent.push(message);
        return { accepted: ["ana@example.test"], refused: [], response: "250 ok" };
    }
}));

const compose = await import("@/lib/mailbox/compose");
const { MailAccessError } = await import("@/lib/mailbox/access");
const { MailRejectedError } = await import("@/lib/mailbox/send");

beforeEach(() => {
    state.draft = draftRow();
    state.sendAs = false;
    state.capability = "respond";
    state.grantsThrow = null;
    state.sendThrows = null;
    state.sent = [];
    state.used = [];
    state.unsent = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00Z"));
});

afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
});

describe("a delegate's message going out", () => {
    it("goes on the holder's behalf, naming the delegate as Sender, and is logged", async () => {
        expect(await compose.deliverQueued(DRAFT)).toBe(true);
        expect(state.sent).toHaveLength(1);
        expect(state.sent[0]?.from.address).toBe("boss@example.test");
        expect(state.sent[0]?.sender).toEqual({ name: "Helper", address: "helper@example.test" });
        expect(state.used).toEqual([
            expect.objectContaining({
                grantId: "grant-1",
                userId: "delegate",
                action: "send on behalf",
                outcome: "done"
            })
        ]);
    });

    it("goes as the mailbox with no Sender when the holder chose send as", async () => {
        state.sendAs = true;
        expect(await compose.deliverQueued(DRAFT)).toBe(true);
        expect(state.sent[0]?.sender).toBeUndefined();
        expect(state.used[0]).toMatchObject({ action: "send as" });
    });

    it("carries no Sender on the holder's own message", async () => {
        state.draft = draftRow({ authorId: null });
        expect(await compose.deliverQueued(DRAFT)).toBe(true);
        expect(state.sent[0]?.sender).toBeUndefined();
        expect(state.used).toEqual([]);
    });
});

describe("taking the grant back", () => {
    it("stops a message still waiting to go, for good", async () => {
        state.capability = "";
        expect(await compose.deliverQueued(DRAFT)).toBe(false);
        expect(state.sent).toEqual([]);
        expect(state.draft).toMatchObject({
            state: "failed",
            permanent: true,
            sendAt: null,
            failure: "Not sent. This mailbox is no longer shared with you."
        });
        expect(state.used).toEqual([
            expect.objectContaining({ userId: "delegate", outcome: "refused" })
        ]);
    });

    it("stops it when the grant was narrowed below respond", async () => {
        state.capability = "view";
        expect(await compose.deliverQueued(DRAFT)).toBe(false);
        expect(state.sent).toEqual([]);
        expect(state.draft?.permanent).toBe(true);
    });
});

describe("a grant that could not be checked", () => {
    it("is never left sending: it fails, keeps its hour and is tried again", async () => {
        state.grantsThrow = new Error("connection reset");
        expect(await compose.deliverQueued(DRAFT)).toBe(false);
        expect(state.sent).toEqual([]);
        expect(state.draft).toMatchObject({ state: "failed", permanent: false });
        expect(state.draft?.sendAt).not.toBeNull();
        expect(state.draft?.failure).toBe(
            "Not sent yet. Polaris could not check this mailbox is still shared, and will try again."
        );
    });
});

describe("a refusal for good", () => {
    it("is told to the delegate who wrote it", async () => {
        state.sendThrows = new MailRejectedError(
            core.judgeSendFailure({ responseCode: 550, response: "550 5.1.1 User unknown" })
        );
        await compose.deliverQueued(DRAFT);
        expect(state.unsent).toEqual(["delegate"]);
    });

    it("is told to the holder for their own message", async () => {
        state.draft = draftRow({ authorId: null });
        state.sendThrows = new MailRejectedError(
            core.judgeSendFailure({ responseCode: 550, response: "550 5.1.1 User unknown" })
        );
        await compose.deliverQueued(DRAFT);
        expect(state.unsent).toEqual([null]);
    });
});

describe("whose draft it is", () => {
    it("keeps the holder out of a delegate's draft", async () => {
        await expect(compose.cancelSend("holder", DRAFT)).rejects.toBeInstanceOf(MailAccessError);
        await expect(compose.sendNow("holder", DRAFT)).rejects.toBeInstanceOf(MailAccessError);
    });

    it("keeps another delegate out of it", async () => {
        await expect(compose.cancelSend("holder", DRAFT, "someone-else")).rejects.toBeInstanceOf(
            MailAccessError
        );
    });

    it("lets its own author undo it", async () => {
        expect(await compose.cancelSend("holder", DRAFT, "delegate")).toBe(true);
        expect(state.draft?.state).toBe("draft");
    });

    it("keeps a delegate out of the holder's draft", async () => {
        state.draft = draftRow({ authorId: null });
        await expect(compose.cancelSend("holder", DRAFT, "delegate")).rejects.toBeInstanceOf(
            MailAccessError
        );
    });
});
