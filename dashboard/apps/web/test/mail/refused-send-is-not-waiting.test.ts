/**
 * A message the outgoing server would not take must never look like one that is
 * on its way.
 *
 * What this pins is the difference between the two refusals. A 4xx is the server
 * saying "not now": the message keeps its hour, the sweep picks it up again, and
 * the writer is told it will be tried again. A 5xx is the server having decided:
 * the hour is cleared so nothing ever sends the same rejection to the same
 * people again, the writer is told what the server actually said, and the only
 * thing that moves it is them.
 *
 * Before this, both were one sentence - "Polaris will try again" - over a row
 * that kept its hour, so a permanently refused message drew on the Drafts screen
 * as "Waiting to go out" at a time in the past, for ever, and could not be
 * opened, discarded or retried. Somebody reading that has been told their
 * message is going when it is not.
 */

import * as core from "@polaris/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DRAFT = "0198f0aa-0000-7000-8000-000000000001";
const ACCOUNT = "0198f0aa-0000-7000-8000-000000000002";

interface DraftRow {
    id: string;
    accountId: string;
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
    /** What `sendMime` does when it is called. */
    throws: null as unknown,
    recorded: [] as { messageId: string; refused: readonly string[] }[],
    unsent: [] as string[],
    partial: [] as string[],
    /** What the outgoing server took the message for. */
    accepted: ["nobody@example.org"] as string[],
    refusedFor: [] as string[],
    swept: [] as Record<string, unknown>[]
};

function draftRow(over: Partial<DraftRow> = {}): DraftRow {
    return {
        id: DRAFT,
        accountId: ACCOUNT,
        state: "queued",
        failure: "",
        permanent: false,
        attempts: 0,
        sendAt: new Date("2026-09-19T10:00:00Z"),
        subject: "Invoice for March",
        probe: false,
        body: "Here it is.",
        replyTo: "",
        toJson: [{ name: "", address: "nobody@example.org" }],
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
            findFirst: async () => (state.draft ? { id: state.draft.id } : null),
            findUnique: async () => state.draft,
            findMany: async ({ where }: { where: Record<string, unknown> }) => {
                state.swept.push(where);
                return [];
            },
            updateMany: async ({
                where,
                data
            }: {
                where: Record<string, unknown>;
                data: Record<string, unknown>;
            }) => {
                const row = state.draft;
                if (!row || row.id !== where.id) return { count: 0 };
                if (typeof where.state === "string" && row.state !== where.state) return { count: 0 };
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
                userId: "u1",
                address: "me@example.com",
                displayName: "",
                signature: "",
                signatureAboveQuote: true,
                signatureAuto: "never",
                appendToSent: false,
                user: { name: "Me" }
            })
        },
        mailFolder: { findFirst: async () => null },
        mailMessage: { updateMany: async () => ({ count: 0 }) }
    }
}));

vi.mock("@/lib/mailbox/live", () => ({ publishMail: () => undefined }));
vi.mock("@/lib/mailbox/sync", () => ({ refreshThreads: async () => undefined }));
vi.mock("@/lib/mailbox/prefs", () => ({ readMailPreferences: async () => ({ undoSeconds: 0 }) }));
vi.mock("@/lib/mailbox/contacts", () => ({ rememberContacts: async () => undefined }));
vi.mock("@/lib/mailbox/refused", () => ({ recordCredentialRefusal: async () => undefined }));
vi.mock("@/lib/mailbox/credentials", () => ({ MailAuthError: class MailAuthError extends Error {} }));
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
    recordSend: async (sent: { messageId: string; refused: readonly string[] }) => {
        state.recorded.push(sent);
        return "d1";
    },
    recordSentCopy: async () => undefined,
    announceUnsent: async (_id: string, _subject: string, detail: string) => {
        state.unsent.push(detail);
    },
    announcePartial: async (_id: string, _subject: string, detail: string) => {
        state.partial.push(detail);
    }
}));
vi.mock("@/lib/mailbox/send", () => ({
    MailRejectedError: class MailRejectedError extends Error {
        public failure: core.MailSendFailure;
        public constructor(failure: core.MailSendFailure) {
            super(core.sendFailureSentence(failure));
            this.failure = failure;
        }
    },
    composeMime: async () => ({ mime: Buffer.from(""), messageId: "sent-1@example.com" }),
    sendMime: async () => {
        if (state.throws) throw state.throws;
        return { accepted: state.accepted, refused: state.refusedFor, response: "250 ok" };
    }
}));

const compose = await import("@/lib/mailbox/compose");
const { MailRejectedError } = await import("@/lib/mailbox/send");

beforeEach(() => {
    state.draft = draftRow();
    state.throws = null;
    state.recorded.length = 0;
    state.unsent.length = 0;
    state.partial.length = 0;
    state.accepted = ["nobody@example.org"];
    state.refusedFor = [];
    state.swept.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00Z"));
});

afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
});

describe("a message the server refused for good", () => {
    beforeEach(() => {
        state.throws = new MailRejectedError(
            core.judgeSendFailure({
                responseCode: 550,
                response: "550 5.1.1 <nobody@example.org>: Recipient address rejected: User unknown"
            })
        );
    });

    it("says what the server said, not that it will try again", async () => {
        expect(await compose.deliverQueued(DRAFT)).toBe(false);
        expect(state.draft?.state).toBe("failed");
        expect(state.draft?.failure).toContain("User unknown");
        expect(state.draft?.failure).not.toContain("try again");
    });

    it("clears the hour, so nothing sends the same rejection again", async () => {
        await compose.deliverQueued(DRAFT);
        expect(state.draft?.permanent).toBe(true);
        expect(state.draft?.sendAt).toBeNull();
    });

    it("is never recorded as a message that went", async () => {
        await compose.deliverQueued(DRAFT);
        expect(state.recorded).toHaveLength(0);
    });

    it("tells its writer once, because nothing else is going to", async () => {
        await compose.deliverQueued(DRAFT);
        expect(state.unsent).toHaveLength(1);
        expect(state.unsent[0]).toContain("User unknown");
    });
});

describe("a message the server could not take right now", () => {
    beforeEach(() => {
        state.throws = new MailRejectedError(
            core.judgeSendFailure({ responseCode: 451, response: "451 4.3.0 try again later" })
        );
    });

    it("keeps its hour and says it will be tried again", async () => {
        await compose.deliverQueued(DRAFT);
        expect(state.draft?.permanent).toBe(false);
        expect(state.draft?.sendAt).not.toBeNull();
        expect(state.draft?.failure).toContain("try again");
    });

    it("says nothing on the bell: there is nothing for anybody to do yet", async () => {
        await compose.deliverQueued(DRAFT);
        expect(state.unsent).toHaveLength(0);
    });

    it("gives up after the last attempt, and says so rather than going quiet", async () => {
        state.draft = draftRow({ attempts: 4 });
        await compose.deliverQueued(DRAFT);
        expect(state.draft?.attempts).toBe(5);
        expect(state.draft?.permanent).toBe(true);
        expect(state.draft?.sendAt).toBeNull();
        expect(state.draft?.failure).toContain("stopped trying");
        expect(state.unsent).toHaveLength(1);
    });
});

describe("a server that never answered at all", () => {
    it("is Polaris' own sentence, never the socket's", async () => {
        state.throws = new Error("getaddrinfo ENOTFOUND smtp.example.net");
        await compose.deliverQueued(DRAFT);
        expect(state.draft?.failure).toBe(
            "Not sent yet. Polaris could not reach the outgoing server, and will try again."
        );
        expect(state.draft?.failure).not.toContain("example.net");
        expect(state.draft?.permanent).toBe(false);
    });
});

describe("the sweep", () => {
    it("never picks up a message that was refused for good", async () => {
        await compose.sweepDueSends();
        expect(state.swept[0]).toMatchObject({ permanent: false });
    });
});

describe("try again", () => {
    it("puts a refused message back in the queue, once", async () => {
        state.draft = draftRow({ state: "failed", permanent: true, attempts: 3, sendAt: null });
        expect(await compose.retrySend("u1", DRAFT)).toBe(true);
        expect(state.draft?.state).toBe("queued");
        expect(state.draft?.permanent).toBe(false);
        expect(state.draft?.attempts).toBe(0);

        // The row is no longer `failed`, so a second press - or a sweep landing
        // at the same moment - finds nothing to claim and sends nothing.
        expect(await compose.retrySend("u1", DRAFT)).toBe(false);
    });

    it("refuses a message that is not refused", async () => {
        state.draft = draftRow({ state: "queued" });
        expect(await compose.retrySend("u1", DRAFT)).toBe(false);
    });
});

describe("a message that went", () => {
    it("is recorded, with the name it gave itself", async () => {
        expect(await compose.deliverQueued(DRAFT)).toBe(true);
        expect(state.recorded).toEqual([
            expect.objectContaining({ messageId: "sent-1@example.com", refused: [] })
        ]);
        // Gone means gone: the queue entry is deleted, so no sweep can find it.
        expect(state.draft).toBeNull();
    });

    it("says so when the server took it for some people and refused it for others", async () => {
        state.accepted = ["one@example.org"];
        state.refusedFor = ["two@example.org"];
        expect(await compose.deliverQueued(DRAFT)).toBe(true);
        // Sent, and recorded as sent - because it was, to somebody. The half
        // nobody would otherwise find out about is what reaches the bell.
        expect(state.recorded[0]?.refused).toEqual(["two@example.org"]);
        expect(state.partial).toHaveLength(1);
        expect(state.partial[0]).toContain("two@example.org");
    });
});
