/**
 * A pass that changed nothing tells no open tab anything.
 *
 * A watched mailbox is asked every twenty seconds, and every pass used to end
 * with a frame. Each frame sent every open tab of the person back to recount its
 * unread mail and to ask what had arrived - measured on a live install at one
 * frame every four seconds and nine requests per frame, more than half of all
 * the dashboard's traffic, for an answer identical to the last one.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listed = vi.hoisted(() => ({ messages: 3, unseen: 1 }));
const held = vi.hoisted(() => ({
    row: null as null | Record<string, unknown>
}));
const published = vi.hoisted(() => ({ frames: [] as unknown[] }));

const account = vi.hoisted(() => ({
    id: "acc_1",
    userId: "usr_ana",
    state: "ok",
    stateDetail: null,
    lastSyncAt: new Date("2026-11-01T08:00:00Z"),
    lastOkAt: new Date("2026-11-01T08:00:00Z"),
    createdAt: new Date("2026-01-01T08:00:00Z")
}));

vi.mock("imapflow", () => ({ ImapFlow: class {} }));
vi.mock("@/lib/audit-service", () => ({ audit: async () => undefined }));
vi.mock("@/lib/mailbox/live", () => ({
    publishMail: (change: unknown) => void published.frames.push(change)
}));
vi.mock("@/lib/setting-store", () => ({ getSetting: async () => null }));
vi.mock("@polaris/db", () => ({
    prisma: {
        mailAccount: { findUnique: async () => account },
        mailFolder: {
            findUnique: async () => held.row,
            findMany: async () => [],
            update: async () => undefined,
            create: async () => undefined,
            deleteMany: async () => undefined,
            updateMany: async () => undefined
        },
        mailMessage: { findMany: async () => [], findFirst: async () => null }
    }
}));
vi.mock("@/lib/mailbox/credentials", () => ({
    MailAuthError: class MailAuthError extends Error {},
    mailCredential: async () => ({ kind: "password", username: "ana", password: "fixture" }),
    withMailCredential: async (
        _account: unknown,
        attempt: (credential: unknown) => Promise<unknown>
    ) =>
        attempt({ kind: "password", username: "ana", password: "fixture" })
}));
vi.mock("@/lib/mailbox/refused", () => ({ recordCredentialRefusal: async () => undefined }));
vi.mock("@/lib/mailbox/accounts", () => ({
    recordAccountAttempt: async () => undefined,
    recordAccountState: async () => undefined
}));
vi.mock("@/lib/mailbox/imap", () => ({
    MailUnreachableError: class MailUnreachableError extends Error {},
    withImap: async (_account: unknown, run: (client: unknown) => Promise<void>) =>
        run({
            list: async () => [
                {
                    path: "INBOX",
                    delimiter: "/",
                    flags: new Set<string>(),
                    subscribed: true,
                    status: { messages: listed.messages, unseen: listed.unseen }
                }
            ]
        })
}));

const { syncAccount, folderMoved } = await import("@/lib/mailbox/sync");

/** The row as the last pass left it: exactly what the server lists now. */
function heldAsListed(): Record<string, unknown> {
    const { role, flagged } = core.folderRoleFrom("INBOX", [], "/");
    return {
        id: "fld_inbox",
        subscribed: true,
        roleLocked: false,
        delimiter: "/",
        name: core.folderLabel("INBOX", "/"),
        role,
        roleFlagged: flagged,
        total: listed.messages,
        unread: listed.unseen
    };
}

beforeEach(() => {
    published.frames = [];
    listed.messages = 3;
    listed.unseen = 1;
    held.row = heldAsListed();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("a mail pass", () => {
    it("sends no frame when nothing in the mailbox moved", async () => {
        await syncAccount(account.id, { force: true });
        expect(published.frames).toEqual([]);
    });

    it("sends one when a message was read somewhere else", async () => {
        listed.unseen = 0;
        await syncAccount(account.id, { force: true });
        expect(published.frames).toEqual([
            { accountId: account.id, kind: "folders", actorId: account.userId }
        ]);
    });

    it("sends one when a folder appears", async () => {
        held.row = null;
        await syncAccount(account.id, { force: true });
        expect(published.frames).toHaveLength(1);
    });
});

describe("folderMoved", () => {
    const row = {
        delimiter: "/",
        name: "Inbox",
        role: "inbox",
        roleFlagged: false,
        total: 3,
        unread: 1
    };

    it("is false for the same figures", () => {
        expect(folderMoved(row, { ...row })).toBe(false);
    });

    it("ignores a role the pass does not write", () => {
        expect(folderMoved(row, { delimiter: "/", name: "Inbox", total: 3, unread: 1 })).toBe(
            false
        );
    });

    it("is true for a moved count, name or role", () => {
        expect(folderMoved(row, { ...row, total: 4 })).toBe(true);
        expect(folderMoved(row, { ...row, unread: 0 })).toBe(true);
        expect(folderMoved(row, { ...row, name: "Received" })).toBe(true);
        expect(folderMoved(row, { ...row, role: "archive" })).toBe(true);
    });
});
