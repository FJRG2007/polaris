/**
 * The sending check, and the line it is not allowed to cross.
 *
 * A check that says "sending works" because the provider answered 250 is a check
 * that passes on a mailbox whose mail nobody ever receives, and somebody will
 * believe it. So there are two different good answers, and they are different
 * sentences: the provider took it, and the message came back into this mailbox.
 * Only the second is proof.
 *
 * The trap pinned here is the copy Polaris files in Sent: it is the same message
 * with the same Message-Id, so a check that simply looked for the id would find
 * its own copy and declare a round trip that never happened.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ACCOUNT = "0198f0aa-0000-7000-8000-00000000000b";

const state = {
    draft: null as Record<string, unknown> | null,
    delivery: null as Record<string, unknown> | null,
    /** The folder roles the round-trip copy was found under, if any. */
    arrivalIn: null as string | null,
    messageWhere: null as Record<string, unknown> | null
};

vi.mock("@polaris/db", () => ({
    prisma: {
        mailDraft: {
            findFirst: async () => state.draft,
            create: async () => ({ id: "d1" }),
            update: async () => ({})
        },
        mailDelivery: { findFirst: async () => state.delivery },
        mailMessage: {
            findFirst: async ({ where }: { where: Record<string, unknown> }) => {
                state.messageWhere = where;
                const roles = (where.folder as { role: { notIn: string[] } }).role.notIn;
                if (!state.arrivalIn || roles.includes(state.arrivalIn)) return null;
                return { id: "m1" };
            }
        }
    }
}));

vi.mock("@/lib/mailbox/access", () => ({
    ownedAccount: async () => ({ id: ACCOUNT, address: "me@example.com" })
}));
vi.mock("@/lib/mailbox/compose", () => ({ queueSend: async () => ({ draftId: "d1" }) }));

const selftest = await import("@/lib/mailbox/selftest");

beforeEach(() => {
    state.draft = null;
    state.delivery = null;
    state.arrivalIn = null;
    state.messageWhere = null;
});

describe("what the check reports", () => {
    it("says nothing at all before one has been run", async () => {
        expect(await selftest.readSendCheck("u1", ACCOUNT)).toMatchObject({ stage: "none" });
    });

    it("says it is sending while the message is in the queue", async () => {
        state.draft = { state: "queued", failure: "", permanent: false, createdAt: new Date() };
        expect(await selftest.readSendCheck("u1", ACCOUNT)).toMatchObject({
            stage: "sending",
            waiting: true
        });
    });

    it("says what the server said when it was refused", async () => {
        state.draft = {
            state: "failed",
            failure: "Not sent. The outgoing server refused it: 550 5.7.1 not authenticated",
            permanent: true,
            createdAt: new Date()
        };
        const check = await selftest.readSendCheck("u1", ACCOUNT);
        expect(check.stage).toBe("refused");
        expect(check.detail).toContain("550 5.7.1");
        expect(check.waiting).toBe(false);
    });

    it("claims only that the provider took it while nothing has come back", async () => {
        state.delivery = {
            messageId: "check-1@example.com",
            state: "accepted",
            detail: "",
            sentCopy: "filed",
            sentAt: new Date()
        };
        const check = await selftest.readSendCheck("u1", ACCOUNT);
        expect(check.stage).toBe("accepted");
        expect(check.detail).toContain("accepted the message");
        expect(check.detail).not.toContain("both work");
    });

    it("does not mistake the copy Polaris filed in Sent for the message arriving", async () => {
        state.delivery = {
            messageId: "check-1@example.com",
            state: "accepted",
            detail: "",
            sentCopy: "filed",
            sentAt: new Date()
        };
        state.arrivalIn = "sent";
        expect(await selftest.readSendCheck("u1", ACCOUNT)).toMatchObject({ stage: "accepted" });
        expect(state.messageWhere?.folder).toEqual({ role: { notIn: ["sent", "drafts"] } });
    });

    it("says sending and receiving both work only when it came back to the inbox", async () => {
        state.delivery = {
            messageId: "check-1@example.com",
            state: "accepted",
            detail: "",
            sentCopy: "filed",
            sentAt: new Date()
        };
        state.arrivalIn = "inbox";
        const check = await selftest.readSendCheck("u1", ACCOUNT);
        expect(check.stage).toBe("arrived");
        expect(check.detail).toContain("both work");
        expect(check.waiting).toBe(false);
    });

    it("reports a bounce as a bounce, in the reporting server's words", async () => {
        state.delivery = {
            messageId: "check-1@example.com",
            state: "bounced",
            detail: "It did not reach me@example.com: mailbox full",
            sentCopy: "filed",
            sentAt: new Date()
        };
        expect(await selftest.readSendCheck("u1", ACCOUNT)).toMatchObject({
            stage: "bounced",
            detail: "It did not reach me@example.com: mailbox full"
        });
    });

    it("says when nothing is being kept in Sent, which is its own thing to fix", async () => {
        state.delivery = {
            messageId: "check-1@example.com",
            state: "accepted",
            detail: "",
            sentCopy: "failed",
            sentAt: new Date()
        };
        expect((await selftest.readSendCheck("u1", ACCOUNT)).detail).toContain("No copy");
    });
});

describe("starting one", () => {
    it("does not start a second while one is still on its way", async () => {
        state.draft = { state: "queued", failure: "", permanent: false, createdAt: new Date() };
        expect(await selftest.startSendCheck("u1", ACCOUNT)).toMatchObject({ stage: "sending" });
    });
});
