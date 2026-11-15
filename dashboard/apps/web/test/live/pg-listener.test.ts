/**
 * The process-wide LISTEN connection: one connection for every subscriber,
 * reconnect with backoff, catch-up from the last time it was alive, and the
 * payload size guard.
 */

import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import * as live from "@/lib/live/pg-listener";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (...args: unknown[]) => void;

/** A stand-in for `pg.Client`, driven by the test. */
class FakeClient implements live.ListenerClient {
    readonly queries: string[] = [];
    readonly handlers = new Map<string, Handler[]>();
    ended = false;
    failConnect = false;
    dbNow = new Date("2027-01-01T00:00:00.000Z");

    async connect(): Promise<void> {
        if (this.failConnect) throw new Error("connect ECONNREFUSED");
    }

    async query(text: string): Promise<{ rows: Record<string, unknown>[] }> {
        this.queries.push(text);
        if (text.startsWith("SELECT now()")) return { rows: [{ now: this.dbNow }] };
        return { rows: [] };
    }

    on(event: string, listener: Handler): this {
        this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
        return this;
    }

    async end(): Promise<void> {
        this.ended = true;
    }

    emit(event: string, ...args: unknown[]): void {
        for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }

    notify(channel: string, payload: string): void {
        this.emit("notification", { channel, payload });
    }
}

/** Let pending promise chains run without moving the clock. */
async function settle(): Promise<void> {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe("the process listener", () => {
    let clients: FakeClient[];
    let listener: live.PgListener;
    let next: () => FakeClient;

    beforeEach(() => {
        vi.useFakeTimers();
        clients = [];
        next = () => new FakeClient();
        listener = new live.PgListener({
            open: () => {
                const client = next();
                clients.push(client);
                return client;
            },
            random: () => 1,
            now: () => Date.now()
        });
        vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(async () => {
        await listener.close();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("opens one connection for every subscriber and channel, and fans a notice out", async () => {
        const seenA: string[] = [];
        const seenB: string[] = [];
        listener.listen("polaris_agent_session", { onNotice: (payload) => seenA.push(payload) });
        listener.listen("polaris_agent_session", { onNotice: (payload) => seenB.push(payload) });
        await settle();
        listener.listen("polaris_other", { onNotice: () => undefined });
        await settle();

        expect(clients).toHaveLength(1);
        expect(listener.connected).toBe(true);
        expect(clients[0].queries.filter((query) => query.startsWith("LISTEN"))).toEqual([
            'LISTEN "polaris_agent_session"',
            'LISTEN "polaris_other"'
        ]);

        clients[0].notify("polaris_agent_session", '{"s":"x","k":"event"}');
        clients[0].notify("polaris_other", "ignored by the session subscribers");
        expect(seenA).toEqual(['{"s":"x","k":"event"}']);
        expect(seenB).toEqual(['{"s":"x","k":"event"}']);
    });

    it("stops delivering to a subscriber that left", async () => {
        const seen: string[] = [];
        const leave = listener.listen("polaris_agent_session", { onNotice: (payload) => seen.push(payload) });
        await settle();
        leave();
        clients[0].notify("polaris_agent_session", "{}");
        expect(seen).toEqual([]);
    });

    it("keeps delivering when one subscriber throws", async () => {
        const seen: string[] = [];
        listener.listen("polaris_agent_session", {
            onNotice: () => {
                throw new Error("a dead browser connection");
            }
        });
        listener.listen("polaris_agent_session", { onNotice: (payload) => seen.push(payload) });
        await settle();
        clients[0].notify("polaris_agent_session", "{}");
        expect(seen).toEqual(["{}"]);
    });

    it("drops a payload at or over Postgres' limit, and anything that is not text", async () => {
        const seen: string[] = [];
        listener.listen("polaris_agent_session", { onNotice: (payload) => seen.push(payload) });
        await settle();
        clients[0].notify("polaris_agent_session", "x".repeat(live.NOTIFY_PAYLOAD_LIMIT));
        // Multi-byte text is measured in bytes, not characters.
        clients[0].notify("polaris_agent_session", "é".repeat(live.NOTIFY_PAYLOAD_LIMIT / 2));
        clients[0].emit("notification", { channel: "polaris_agent_session" });
        clients[0].notify("polaris_agent_session", "x".repeat(live.NOTIFY_PAYLOAD_LIMIT - 1));
        expect(seen).toHaveLength(1);
        expect(seen[0]).toHaveLength(live.NOTIFY_PAYLOAD_LIMIT - 1);
    });

    it("refuses a channel name that cannot be a bare identifier", () => {
        expect(() => listener.listen('x"; DROP TABLE "User', { onNotice: () => undefined })).toThrow();
        expect(clients).toHaveLength(0);
    });

    it("reconnects with growing backoff and listens again", async () => {
        listener.listen("polaris_agent_session", { onNotice: () => undefined });
        await settle();
        expect(clients).toHaveLength(1);

        next = () => Object.assign(new FakeClient(), { failConnect: true });
        clients[0].emit("error", new Error("terminating connection"));
        expect(clients[0].ended).toBe(true);
        expect(listener.connected).toBe(false);

        // First retry after 1 s (random() = 1 takes the full ceiling).
        await vi.advanceTimersByTimeAsync(999);
        expect(clients).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(clients).toHaveLength(2);
        // That one failed: the next waits 2 s.
        await vi.advanceTimersByTimeAsync(1_999);
        expect(clients).toHaveLength(2);
        next = () => new FakeClient();
        await vi.advanceTimersByTimeAsync(1);
        expect(clients).toHaveLength(3);
        expect(listener.connected).toBe(true);
        expect(clients[2].queries).toContain('LISTEN "polaris_agent_session"');
    });

    it("treats a heartbeat that fails as a dead connection", async () => {
        listener.listen("polaris_agent_session", { onNotice: () => undefined });
        await settle();
        clients[0].query = async () => {
            throw new Error("Query read timeout");
        };
        await vi.advanceTimersByTimeAsync(30_000);
        expect(clients[0].ended).toBe(true);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(clients).toHaveLength(2);
        expect(listener.connected).toBe(true);
    });

    it("asks for a catch-up from when the old connection was last alive", async () => {
        const resyncs: Date[] = [];
        listener.listen("polaris_agent_session", {
            onNotice: () => undefined,
            onResync: (since) => {
                resyncs.push(since);
            }
        });
        await settle();
        // The first connection catches up on the moment it took to open.
        expect(resyncs).toHaveLength(1);
        expect(resyncs[0].toISOString()).toBe(
            new Date(Date.parse("2027-01-01T00:00:00.000Z") - live.RESYNC_MARGIN_MS).toISOString()
        );

        // Alive at 00:00:30 by the database's clock, then gone.
        clients[0].dbNow = new Date("2027-01-01T00:00:30.000Z");
        await vi.advanceTimersByTimeAsync(30_000);
        next = () => Object.assign(new FakeClient(), { dbNow: new Date("2027-01-01T00:05:00.000Z") });
        clients[0].emit("end");
        await vi.advanceTimersByTimeAsync(1_000);

        expect(resyncs).toHaveLength(2);
        expect(resyncs[1].toISOString()).toBe(
            new Date(Date.parse("2027-01-01T00:00:30.000Z") - live.RESYNC_MARGIN_MS).toISOString()
        );
        // LISTEN was back on before the catch-up was asked for.
        expect(clients[1].queries[0]).toBe('LISTEN "polaris_agent_session"');
    });

    it("stays off without retrying when there is no database to listen to", async () => {
        const off = new live.PgListener({ open: () => null });
        off.listen("polaris_agent_session", { onNotice: () => undefined });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(off.connected).toBe(false);
    });
});

describe("the listener connection settings", () => {
    it("takes Prisma's own parameters out of the URL", () => {
        const config = live.listenerConfig(
            "postgresql://polaris:s%40cret@postgres:5433/polaris?schema=public&connection_limit=15"
        );
        expect(config).toMatchObject({
            host: "postgres",
            port: 5433,
            database: "polaris",
            user: "polaris",
            password: "s@cret",
            ssl: false,
            application_name: "polaris-live",
            keepAlive: true
        });
    });

    it("reads sslmode the way Prisma reads the same URL", () => {
        expect(live.listenerConfig("postgresql://u:p@db/x?sslmode=require").ssl).toEqual({
            rejectUnauthorized: false
        });
        expect(live.listenerConfig("postgresql://u:p@db/x?sslmode=verify-full").ssl).toBe(true);
        expect(live.listenerConfig("postgresql://u:p@db/x?sslmode=disable").ssl).toBe(false);
    });
});

describe("the session trigger's notice", () => {
    const sql = readFileSync(
        resolve(
            __dirname,
            "../../../../packages/db/prisma/migrations/20271119000002_agent_session_live_notify/migration.sql"
        ),
        "utf8"
    );

    it("carries the session id and a kind, never row content, well under the limit", () => {
        expect(sql).toMatch(/json_build_object\('s', sid, 'k', kind\)/);
        // The largest it can be: a 36-character uuid and the longest kind.
        const largest = JSON.stringify({ s: "00000000-0000-0000-0000-000000000000", k: "permission" });
        expect(Buffer.byteLength(largest)).toBeLessThan(live.NOTIFY_PAYLOAD_LIMIT / 100);
    });

    it("is on every table a session page reads", () => {
        for (const table of ["AgentSession", "AgentSessionEvent", "AgentSessionMessage", "AgentPermissionRequest"]) {
            expect(sql).toContain(`DROP TRIGGER IF EXISTS "${table}_live_notify" ON "${table}";`);
            expect(sql).toContain(`AFTER INSERT OR UPDATE OR DELETE ON "${table}"`);
        }
    });
});
