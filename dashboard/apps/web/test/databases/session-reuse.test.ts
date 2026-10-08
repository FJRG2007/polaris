/**
 * What one screenful of browsing costs, through an SSH tunnel.
 *
 * The same sequence a person makes opening a table - the tree, two pages of
 * rows, a typed statement, the tree again, one edited cell - run twice: once on
 * an address with no owner (every call opens and closes its own tunnel and
 * login, as all of them did before sessions) and once on an address resolved for
 * somebody's connection, which borrows from a held session. The engine and the
 * SSH server are fakes that count what was opened.
 */

import { NO_TLS } from "@/lib/data/tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const counts = vi.hoisted(() => ({ ssh: 0, sshClosed: 0, logins: 0, ended: 0 }));

vi.mock("pg", async () => {
    const { EventEmitter } = await import("node:events");
    class Query extends EventEmitter {
        constructor(readonly config: { text: string }) {
            super();
        }
    }
    class Client {
        on() {
            return this;
        }
        async connect() {
            counts.logins += 1;
        }
        async end() {
            counts.ended += 1;
        }
        query(query: string | Query | { text: string }) {
            if (query instanceof Query) {
                queueMicrotask(() => {
                    query.emit("row", [1]);
                    query.emit("end", { fields: [{ name: "n" }], rowCount: 1 });
                });
                return query;
            }
            const text = typeof query === "string" ? query : query.text;
            if (text.includes("FROM pg_database"))
                return Promise.resolve({ rows: [{ name: "app" }] });
            if (text.includes("FROM pg_namespace"))
                return Promise.resolve({ rows: [{ name: "public", count: "1" }] });
            if (text.includes("FROM pg_attribute")) {
                return Promise.resolve({
                    rows: [
                        { name: "id", type: "integer", nullable: "NO", pk: true },
                        { name: "title", type: "text", nullable: "YES", pk: false }
                    ]
                });
            }
            if (text.includes("FROM pg_class"))
                return Promise.resolve({ rows: [{ name: "posts", kind: "table", rows: "2" }] });
            if (text.startsWith("UPDATE")) return Promise.resolve({ rows: [], rowCount: 1 });
            return Promise.resolve({ rows: [{ id: 1, title: "a" }], fields: [] });
        }
    }
    return { Client, Query };
});

vi.mock("@/lib/data/tunnel", () => ({
    TunnelError: class TunnelError extends Error {},
    openTunnel: async () => {
        counts.ssh += 1;
        let alive = true;
        return {
            host: "127.0.0.1",
            port: 40_000,
            alive: () => alive,
            close: () => {
                alive = false;
                counts.sshClosed += 1;
            }
        };
    }
}));
vi.mock("@/lib/data/connections", () => ({ addressOf: vi.fn() }));

const browser = await import("@/lib/data/browser");
const { closeSessions } = await import("@/lib/data/open");

type Address = Parameters<typeof browser.browseAt>[0];

function address(session: Address["session"]): Address {
    return {
        engine: "postgres",
        host: "10.0.0.5",
        port: 5432,
        database: "app",
        username: "reader",
        password: "fixture-password",
        tls: NO_TLS,
        readOnly: false,
        tunnel: { target: {} as never, jump: null, label: "bastion" },
        session
    };
}

/** Open a table, page it, type a statement, look again, change one cell. */
async function browseATable(target: Address): Promise<void> {
    await browser.browseAt(target, null);
    await browser.rowsAt(target, "public", "posts", { limit: 100 });
    await browser.rowsAt(target, "public", "posts", { limit: 100, offset: 100 });
    await browser.runAt(target, "SELECT 1");
    await browser.browseAt(target, "public");
    await browser.updateCellAt(target, {
        namespace: "public",
        relation: "posts",
        column: "title",
        value: "b",
        key: { id: 1 }
    });
}

beforeEach(() => {
    counts.ssh = 0;
    counts.sshClosed = 0;
    counts.logins = 0;
    counts.ended = 0;
});

afterEach(() => {
    closeSessions("alice", "conn-1");
    closeSessions("bob", "conn-1");
});

describe("a screenful of browsing through a tunnel", () => {
    it("costs a handshake and a login per call without a session", async () => {
        await browseATable(address(null));
        expect(counts).toMatchObject({ ssh: 6, sshClosed: 6, logins: 6, ended: 6 });
    });

    it("costs one handshake and two logins with one", async () => {
        await browseATable(address({ userId: "alice", connectionId: "conn-1" }));
        // One login is kept for the reads and edits; the typed statement's is
        // closed after it, so nothing it left on its session is reused.
        expect(counts).toMatchObject({ ssh: 1, logins: 2, ended: 1, sshClosed: 0 });

        closeSessions("alice", "conn-1");
        expect(counts.sshClosed).toBe(1);
    });

    it("gives another account its own tunnel for the same connection", async () => {
        await browser.browseAt(address({ userId: "alice", connectionId: "conn-1" }), null);
        await browser.browseAt(address({ userId: "bob", connectionId: "conn-1" }), null);
        expect(counts.ssh).toBe(2);
    });

    it("still enforces read-only on a held session", async () => {
        const readOnly = {
            ...address({ userId: "alice", connectionId: "conn-1" }),
            readOnly: true
        };
        await expect(browser.runAt(readOnly, "DELETE FROM posts")).rejects.toThrow(/read-only/);
        await expect(
            browser.updateCellAt(readOnly, {
                namespace: "public",
                relation: "posts",
                column: "title",
                value: "b",
                key: { id: 1 }
            })
        ).rejects.toThrow(/read-only/);
    });
});
