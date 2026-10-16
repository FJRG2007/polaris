/**
 * New mail appears the moment the server has it.
 *
 * Every read used to be a pass that asked: twenty seconds apart while somebody
 * had Polaris open, five minutes otherwise, so mail that the provider's own app
 * showed at once sat on the server here until the next pass. The inbox now has
 * a connection of its own held in IDLE, and the server says when it moved.
 *
 * What is pinned here is the listener's life: a notice from the server brings
 * the inbox up to date, a dropped connection comes back on a backoff, a server
 * without IDLE gets no connection held open, a refused credential is not tried
 * again by the listener, and nobody watching means nothing held.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeClient extends EventEmitter {
    capabilities: Map<string, boolean>;
    usable: boolean;
    opened: string[];
    loggedOut: boolean;
    endIdle: () => void;
    drop: () => void;
}

const clients: FakeClient[] = [];
const state = {
    capabilities: ["IMAP4rev1", "IDLE"] as string[],
    connectError: null as Error | null,
    account: { id: "acc_1", userId: "usr_1", state: "ok" } as Record<string, unknown> | null
};

vi.mock("imapflow", () => ({
    ImapFlow: class extends EventEmitter {
        capabilities = new Map(state.capabilities.map((name) => [name, true]));
        usable = true;
        opened: string[] = [];
        loggedOut = false;
        endIdle: () => void = () => undefined;
        constructor() {
            super();
            clients.push(this as unknown as FakeClient);
        }
        async connect() {
            if (state.connectError) throw state.connectError;
        }
        async mailboxOpen(path: string) {
            this.opened.push(path);
        }
        idle() {
            return new Promise<boolean>((resolve) => {
                this.endIdle = () => resolve(true);
            });
        }
        drop() {
            this.usable = false;
            this.emit("close");
        }
        async logout() {
            this.loggedOut = true;
            this.drop();
        }
        close() {
            this.drop();
        }
    }
}));

class FakeAuthError extends Error {}

vi.mock("@/lib/mailbox/credentials", () => ({
    MailAuthError: FakeAuthError,
    mailCredential: async () => ({
        kind: "password",
        user: "fixture@example.test",
        pass: "fixture"
    })
}));

vi.mock("@/lib/mailbox/access", () => ({ ACCOUNT_COLUMNS: { id: true } }));

vi.mock("@polaris/db", () => ({
    prisma: {
        mailAccount: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                state.account && {
                    imapHost: "imap.example.test",
                    imapPort: 993,
                    imapSecurity: "tls",
                    ...state.account,
                    id: where.id
                }
        },
        mailFolder: { findFirst: async () => ({ id: "fld_inbox", path: "INBOX" }) }
    }
}));

const syncFolderNow = vi.fn(async () => undefined);
vi.mock("@/lib/mailbox/sync", () => ({ syncFolderNow }));

const recordCredentialRefusal = vi.fn(async () => undefined);
vi.mock("@/lib/mailbox/refused", () => ({ recordCredentialRefusal }));

const idle = await import("@/lib/mailbox/idle");
// What the listener reaches for when it starts, loaded now so the first test
// does not race module loading against fake timers.
await Promise.all([
    import("@/lib/mailbox/imap"),
    import("@polaris/db"),
    import("@/lib/mailbox/access"),
    import("@/lib/mailbox/credentials"),
    import("@/lib/mailbox/sync"),
    import("@/lib/mailbox/refused")
]);

/** Let the listener's chain of awaits run, timers included. */
async function settle(ms = 0): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    state.capabilities = ["IMAP4rev1", "IDLE"];
    state.connectError = null;
    state.account = { id: "acc_1", userId: "usr_1", state: "ok" };
});

afterEach(async () => {
    const stopping = idle.stopAllInboxListeners();
    await settle(1_000);
    await stopping;
    clients.length = 0;
    syncFolderNow.mockClear();
    recordCredentialRefusal.mockClear();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("a notice from the server", () => {
    it("opens the inbox and catches it up once on connecting", async () => {
        idle.holdInboxListeners("usr_1", ["acc_1"]);
        await settle(1_000);
        expect(clients).toHaveLength(1);
        expect(clients[0].opened).toEqual(["INBOX"]);
        expect(syncFolderNow).toHaveBeenCalledTimes(1);
        expect(syncFolderNow).toHaveBeenCalledWith("acc_1", "fld_inbox");
    });

    it("brings the inbox up to date when a message arrives, a burst as one", async () => {
        idle.holdInboxListeners("usr_1", ["acc_1"]);
        await settle(1_000);
        syncFolderNow.mockClear();

        clients[0].emit("exists", { path: "INBOX", count: 11, prevCount: 10 });
        clients[0].emit("flags", { path: "INBOX", seq: 11 });
        await settle(1_000);
        expect(syncFolderNow).toHaveBeenCalledTimes(1);
        expect(syncFolderNow).toHaveBeenCalledWith("acc_1", "fld_inbox");

        clients[0].emit("expunge", { path: "INBOX", seq: 3 });
        await settle(1_000);
        expect(syncFolderNow).toHaveBeenCalledTimes(2);
    });

    it("issues IDLE again when the server ends one, on the same connection", async () => {
        idle.holdInboxListeners("usr_1", ["acc_1"]);
        await settle(1_000);
        clients[0].endIdle();
        await settle(2_000);
        expect(clients).toHaveLength(1);
        clients[0].emit("exists", { path: "INBOX", count: 2, prevCount: 1 });
        await settle(1_000);
        expect(syncFolderNow).toHaveBeenCalledTimes(2);
    });
});

describe("a dropped connection", () => {
    it("comes back after a backoff, and catches up what it missed", async () => {
        idle.holdInboxListeners("usr_1", ["acc_1"]);
        await settle(1_000);
        clients[0].drop();
        await settle(1_000);
        // Still inside the shortest wait.
        expect(clients).toHaveLength(1);
        await settle(idle.RECONNECT_MIN_MS);
        expect(clients).toHaveLength(2);
        expect(clients[1].opened).toEqual(["INBOX"]);
        expect(syncFolderNow).toHaveBeenCalledTimes(2);
    });

    it("waits longer each time a server keeps refusing the connection", async () => {
        vi.spyOn(Math, "random").mockReturnValue(1);
        idle.holdInboxListeners("usr_1", ["acc_1"]);
        await settle(1_000);
        state.connectError = new Error("ECONNREFUSED");
        clients[0].drop();
        // Attempts 5s, then 10s, then 20s apart.
        await settle(5_000);
        expect(clients).toHaveLength(2);
        await settle(9_000);
        expect(clients).toHaveLength(2);
        await settle(1_000);
        expect(clients).toHaveLength(3);
        await settle(19_000);
        expect(clients).toHaveLength(3);
        await settle(1_000);
        expect(clients).toHaveLength(4);
    });

    it("spaces reconnects out by doubling, capped, with jitter", () => {
        expect(idle.reconnectDelayMs(0, () => 1)).toBe(idle.RECONNECT_MIN_MS);
        expect(idle.reconnectDelayMs(0, () => 0)).toBe(idle.RECONNECT_MIN_MS / 2);
        expect(idle.reconnectDelayMs(1, () => 1)).toBe(idle.RECONNECT_MIN_MS * 2);
        expect(idle.reconnectDelayMs(3, () => 1)).toBe(idle.RECONNECT_MIN_MS * 8);
        expect(idle.reconnectDelayMs(50, () => 1)).toBe(idle.RECONNECT_MAX_MS);
    });
});

describe("what is never held open", () => {
    it("nothing for a server without IDLE, which the passes keep covering", async () => {
        state.capabilities = ["IMAP4rev1"];
        idle.holdInboxListeners("usr_1", ["acc_plain"]);
        await settle(1_000);
        expect(clients).toHaveLength(1);
        expect(clients[0].loggedOut).toBe(true);
        expect(clients[0].opened).toEqual([]);
        expect(idle.listenedMailboxes().has("acc_plain")).toBe(false);

        // And it is not asked again on the next tick.
        idle.holdInboxListeners("usr_1", ["acc_plain"]);
        await settle(30_000);
        expect(clients).toHaveLength(1);
    });

    it("nothing for a mailbox whose credential was refused", async () => {
        state.account = { id: "acc_1", userId: "usr_1", state: "auth" };
        idle.holdInboxListeners("usr_1", ["acc_1"]);
        await settle(60_000);
        expect(clients).toHaveLength(0);
    });

    it("no retry once the server refuses the credential", async () => {
        state.connectError = new FakeAuthError("refused");
        idle.holdInboxListeners("usr_1", ["acc_1"]);
        await settle(1_000);
        expect(recordCredentialRefusal).toHaveBeenCalledWith("acc_1", "refused");
        const tried = clients.length;
        await settle(30 * 60_000);
        expect(clients.length).toBe(tried);
        expect(idle.listenedMailboxes().has("acc_1")).toBe(false);
    });

    it("nothing for a mailbox that was removed", async () => {
        state.account = null;
        idle.holdInboxListeners("usr_1", ["acc_1"]);
        await settle(1_000);
        expect(clients).toHaveLength(0);
    });
});

describe("letting go", () => {
    it("logs out when its owner stops watching", async () => {
        idle.holdInboxListeners("usr_1", ["acc_1"]);
        await settle(1_000);
        idle.holdInboxListeners("usr_1", []);
        await settle(1_000);
        expect(clients[0].loggedOut).toBe(true);
        expect(idle.listenedMailboxes().size).toBe(0);
        await settle(60_000);
        expect(clients).toHaveLength(1);
    });

    it("logs out of a mailbox that is no longer theirs and keeps the rest", async () => {
        idle.holdInboxListeners("usr_1", ["acc_1", "acc_2"]);
        await settle(1_000);
        expect(clients).toHaveLength(2);
        idle.holdInboxListeners("usr_1", ["acc_2"]);
        await settle(1_000);
        expect([...idle.listenedMailboxes()]).toEqual(["acc_2"]);
        expect(clients.filter((client) => client.loggedOut)).toHaveLength(1);
    });

    it("does not reconnect a listener stopped while it waits to", async () => {
        idle.holdInboxListeners("usr_1", ["acc_1"]);
        await settle(1_000);
        clients[0].drop();
        await settle(1_000);
        idle.holdInboxListeners("usr_1", []);
        await settle(60_000);
        expect(clients).toHaveLength(1);
    });

    it("holds one listener per mailbox however often it is asked", async () => {
        idle.holdInboxListeners("usr_1", ["acc_1"]);
        idle.holdInboxListeners("usr_1", ["acc_1"]);
        await settle(1_000);
        idle.holdInboxListeners("usr_1", ["acc_1"]);
        await settle(1_000);
        expect(clients).toHaveLength(1);
    });
});
