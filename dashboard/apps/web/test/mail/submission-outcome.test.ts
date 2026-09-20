/**
 * What the outgoing server actually did with the message, read off its answer.
 *
 * Two of these are silent losses that read as successes, and both are the
 * library being reasonable about something a mail client must not be reasonable
 * about:
 *
 * - **Some recipients refused.** Submission resolves when the server took the
 *   message for anybody, and the ones it would not take are in a list nobody
 *   read. Those people never got it, and nothing anywhere said so.
 * - **Every recipient refused.** The same call still resolves, with an empty
 *   accepted list, and the message goes into Sent looking exactly like one that
 *   went.
 *
 * The third thing pinned here is that the server's own reply survives to the
 * screen, and that a socket failure's does not: a reply is about the message and
 * is the whole answer, and a socket error's text is the host the mailbox is
 * configured with, which is Polaris's to say in its own words.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
    /** What the transport does when asked to send. */
    answer: null as unknown,
    throws: null as unknown
};

vi.mock("nodemailer", () => ({
    createTransport: () => ({
        sendMail: async () => {
            if (state.throws) throw state.throws;
            return state.answer;
        },
        verify: async () => true,
        close: () => undefined
    })
}));

class MailAuthError extends Error {}
class MailUnreachableError extends Error {}

vi.mock("@/lib/mailbox/credentials", () => ({
    MailAuthError,
    mailCredential: async () => ({ kind: "password", user: "me@example.com", pass: "x" })
}));
vi.mock("@/lib/mailbox/imap", () => ({
    isLoopback: () => false,
    asMailFailure: (caught: unknown) =>
        caught instanceof MailAuthError ? caught : new MailUnreachableError(String(caught))
}));

const send = await import("@/lib/mailbox/send");

const ACCOUNT = {
    address: "me@example.com",
    username: "",
    auth: "password",
    service: "",
    connectionId: null,
    encryptedSecret: null,
    secretNonce: null,
    secretKeyId: null,
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    smtpSecurity: "starttls"
} as unknown as Parameters<typeof send.sendMime>[0];

const MESSAGE = {
    from: { name: "Me", address: "me@example.com" },
    to: [
        { name: "", address: "one@example.org" },
        { name: "", address: "two@example.org" }
    ],
    cc: [],
    bcc: [],
    replyTo: "",
    subject: "Hello",
    body: "Hello",
    attachments: [],
    inReplyTo: "",
    references: [],
    requestReceipt: false
} as Parameters<typeof send.sendMime>[1];

beforeEach(() => {
    state.answer = null;
    state.throws = null;
});

describe("the message composed", () => {
    it("carries the name it will be known by everywhere else", async () => {
        const composed = await send.composeMime(MESSAGE);
        expect(composed.messageId).toMatch(/^[^<>]+@[^<>]+$/);
        expect(composed.mime.toString("utf8")).toContain(`<${composed.messageId}>`);
    });

    it("is the id the caller asked for, where one was asked for", async () => {
        const composed = await send.composeMime(MESSAGE, { messageId: "<fixed@example.com>" });
        expect(composed.messageId).toBe("fixed@example.com");
    });
});

describe("what the server did with it", () => {
    it("hands back who it took it for, and who it would not", async () => {
        state.answer = {
            accepted: ["one@example.org"],
            rejected: ["two@example.org"],
            response: "250 ok"
        };
        const outcome = await send.sendMime(ACCOUNT, MESSAGE, Buffer.from(""));
        expect(outcome.accepted).toEqual(["one@example.org"]);
        expect(outcome.refused).toEqual(["two@example.org"]);
    });

    it("treats a message the server took for nobody as refused, not as sent", async () => {
        state.answer = {
            accepted: [],
            rejected: ["one@example.org", "two@example.org"],
            response: "550 5.1.1 no such user"
        };
        await expect(send.sendMime(ACCOUNT, MESSAGE, Buffer.from(""))).rejects.toBeInstanceOf(
            send.MailRejectedError
        );
    });

    it("keeps the server's reply, and calls a 5xx final", async () => {
        state.throws = Object.assign(new Error("Command failed"), {
            responseCode: 552,
            response: "552 5.3.4 Message too big for system"
        });
        await send.sendMime(ACCOUNT, MESSAGE, Buffer.from("")).then(
            () => expect.unreachable("a refused message must not resolve"),
            (caught: unknown) => {
                expect(caught).toBeInstanceOf(send.MailRejectedError);
                const rejected = caught as InstanceType<typeof send.MailRejectedError>;
                expect(rejected.failure.verdict).toBe("permanent");
                expect(rejected.failure.reason).toContain("Message too big");
            }
        );
    });

    it("calls a 4xx worth another try", async () => {
        state.throws = Object.assign(new Error("Command failed"), {
            responseCode: 421,
            response: "421 4.7.0 too many connections"
        });
        await send.sendMime(ACCOUNT, MESSAGE, Buffer.from("")).catch((caught: unknown) => {
            expect((caught as InstanceType<typeof send.MailRejectedError>).failure.verdict).toBe(
                "temporary"
            );
        });
    });

    it("leaves a refused credential as the mailbox's problem, not the message's", async () => {
        state.throws = new MailAuthError("This mailbox needs its password again.");
        await expect(send.sendMime(ACCOUNT, MESSAGE, Buffer.from(""))).rejects.toBeInstanceOf(
            MailAuthError
        );
    });

    it("never turns a socket failure into a rejection with the host in it", async () => {
        state.throws = Object.assign(new Error("getaddrinfo ENOTFOUND smtp.example.com"), {
            code: "ESOCKET"
        });
        await expect(send.sendMime(ACCOUNT, MESSAGE, Buffer.from(""))).rejects.toBeInstanceOf(
            MailUnreachableError
        );
    });
});
