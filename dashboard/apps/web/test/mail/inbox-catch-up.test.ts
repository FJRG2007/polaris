/**
 * The catch-up the inbox listener asks for.
 *
 * When the server says the inbox moved, only the inbox is read - a whole pass
 * over every folder to find one message is what made new mail late - and it is
 * read by the same code a pass runs, so the rules and the filters behave as they
 * always did. What is pinned here is how it shares the mailbox with the passes:
 * one connection, never alongside a pass, a burst of notices as one more
 * catch-up, nothing for a refused credential, and a frame for the open tab.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeClient extends EventEmitter {
    locked: string[];
    statusAsked: string[];
}

const clients: FakeClient[] = [];
/** Set to hold the next folder read until the test lets it go. */
let gate: Promise<void> | null = null;
const order: string[] = [];

vi.mock("imapflow", () => ({
    ImapFlow: class extends EventEmitter {
        locked: string[] = [];
        statusAsked: string[] = [];
        mailbox: unknown = false;
        usable = true;
        capabilities = new Map([["IDLE", true]]);
        constructor() {
            super();
            clients.push(this as unknown as FakeClient);
        }
        async connect() {}
        async logout() {}
        close() {}
        async getMailboxLock(path: string) {
            order.push(`lock ${path}`);
            if (gate) await gate;
            this.locked.push(path);
            this.mailbox = { path, uidValidity: 1, uidNext: 5, exists: 4 };
            return { release: () => undefined };
        }
        async *fetch() {}
        async search() {
            return [];
        }
        async status(path: string) {
            this.statusAsked.push(path);
            return { path, unseen: 3 };
        }
    }
}));

vi.mock("@/lib/mailbox/credentials", () => ({
    MailAuthError: class extends Error {},
    mailCredential: async () => ({
        kind: "password",
        user: "fixture@example.test",
        pass: "fixture"
    })
}));

const account = {
    id: "acc_1",
    userId: "usr_1",
    address: "fixture@example.test",
    imapHost: "imap.example.test",
    imapPort: 993,
    imapSecurity: "tls",
    state: "ok",
    lastSyncAt: null
};
const folder = {
    id: "fld_inbox",
    accountId: "acc_1",
    path: "INBOX",
    role: "inbox",
    uidValidity: 1n,
    uidNext: 5n,
    highestModseq: null,
    keywords: false,
    total: 4
};
const accountRow = { current: account as typeof account | null };
const folderUpdates: unknown[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        mailAccount: {
            findUnique: async () => {
                order.push("account");
                return accountRow.current;
            }
        },
        mailFolder: {
            findUnique: async () => folder,
            findMany: async () => [],
            update: async (input: unknown) => {
                folderUpdates.push(input);
                return folder;
            }
        },
        mailMessage: {
            findMany: async () => [],
            count: async () => 0,
            updateMany: async () => ({ count: 0 }),
            deleteMany: async () => ({ count: 0 })
        },
        mailRule: { findMany: async () => [] },
        setting: { findUnique: async () => null }
    }
}));

vi.mock("@/lib/mailbox/rules", () => ({
    applyRulesToMessage: async () => undefined,
    filterHeaderNames: async () => []
}));
vi.mock("@/lib/setting-store", () => ({ getSetting: async () => null }));
vi.mock("@/lib/mailbox/accounts", () => ({
    recordAccountAttempt: async () => undefined,
    recordAccountState: async () => undefined
}));
vi.mock("@/lib/audit-service", () => ({ audit: async () => undefined }));

const published: unknown[] = [];
vi.mock("@/lib/mailbox/live", () => ({
    publishMail: (change: unknown) => published.push(change)
}));

const sync = await import("@/lib/mailbox/sync");

beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
    clients.length = 0;
    published.length = 0;
    folderUpdates.length = 0;
    order.length = 0;
    gate = null;
    accountRow.current = account;
    vi.restoreAllMocks();
});

describe("catching the inbox up", () => {
    it("reads that one folder on one connection, its count with it, and wakes the tab", async () => {
        await sync.syncFolderNow("acc_1", "fld_inbox");
        expect(clients).toHaveLength(1);
        expect(clients[0].locked).toEqual(["INBOX"]);
        expect(clients[0].statusAsked).toEqual(["INBOX"]);
        expect(folderUpdates).toContainEqual({
            where: { id: "fld_inbox" },
            data: { unread: 3 }
        });
        expect(published).toContainEqual({ accountId: "acc_1", kind: "folders", actorId: "usr_1" });
    });

    it("runs once more for a burst of notices while it ran, not once each", async () => {
        let open!: () => void;
        gate = new Promise((resolve) => (open = resolve));
        const first = sync.syncFolderNow("acc_1", "fld_inbox");
        await vi.waitFor(() => expect(order).toContain("lock INBOX"));
        const second = sync.syncFolderNow("acc_1", "fld_inbox");
        const third = sync.syncFolderNow("acc_1", "fld_inbox");
        gate = null;
        open();
        await Promise.all([first, second, third]);
        expect(clients).toHaveLength(2);
    });

    it("never runs alongside a pass: a pass started meanwhile waits for it", async () => {
        let open!: () => void;
        gate = new Promise((resolve) => (open = resolve));
        const catchUp = sync.syncFolderNow("acc_1", "fld_inbox");
        await vi.waitFor(() => expect(order).toContain("lock INBOX"));
        // The pass reads the account first; it must not get that far yet.
        const reads = () => order.filter((step) => step === "account").length;
        const before = reads();
        const pass = sync.syncAccount("acc_1");
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(reads()).toBe(before);
        gate = null;
        open();
        await Promise.all([catchUp, pass]);
        expect(reads()).toBe(before + 1);
        expect(clients).toHaveLength(2);
    });

    it("leaves a refused credential alone", async () => {
        accountRow.current = { ...account, state: "auth" };
        await sync.syncFolderNow("acc_1", "fld_inbox");
        expect(clients).toHaveLength(0);
    });

    it("does nothing for a mailbox that is gone", async () => {
        accountRow.current = null;
        await sync.syncFolderNow("acc_1", "fld_inbox");
        expect(clients).toHaveLength(0);
        expect(published).toHaveLength(0);
    });
});
