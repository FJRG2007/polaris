/**
 * Database sessions held between calls.
 *
 * The cache is driven here with fake routes and drivers that count what they
 * were asked to open, which is the whole question: how many SSH handshakes and
 * database logins a screenful of calls costs, that two people never share one,
 * that an edited connection never reaches the old one, and that a dead tunnel
 * is replaced once rather than retried forever.
 */

import { NO_TLS } from "@/lib/data/tls";
import * as data from "@/lib/data/driver";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    IDLE_MS,
    MAX_PER_USER,
    MAX_QUEUE,
    PER_SESSION,
    PING_AFTER_MS,
    SESSIONS_BUSY,
    SessionCache,
    type SessionRoute
} from "@/lib/data/sessions";

const ALICE = "alice";
const BOB = "bob";

interface FakeTunnel {
    alive: boolean;
    closed: number;
}

let routes: FakeTunnel[];
let drivers: FakeDriver[];
let routeFails = false;

class FakeDriver implements data.DataDriver {
    readonly shape = "sql" as const;
    closed = 0;
    pings = 0;
    async version() {
        this.pings += 1;
        return "fake";
    }
    async namespaces() {
        return [];
    }
    async relations() {
        return [];
    }
    async columns() {
        return [];
    }
    async rows() {
        return { columns: [], rows: [], total: null };
    }
    async run(statement: string) {
        return [{ statement, columns: [], rows: [], affected: null, ms: 0 }];
    }
    async close() {
        this.closed += 1;
    }
    /** What a Redis driver does to switch database: close its own client first. */
    async reopen() {
        await this.close();
    }
}

let clock = 0;

function cache(): SessionCache {
    return new SessionCache({
        now: () => clock,
        route: async (address): Promise<SessionRoute> => {
            if (routeFails) throw new data.DataRequestError("route failed");
            const tunnel: FakeTunnel = { alive: true, closed: 0 };
            routes.push(tunnel);
            return {
                reached: { ...address, host: "127.0.0.1", port: 40_000, tunnel: null },
                tunnel: {
                    host: "127.0.0.1",
                    port: 40_000,
                    alive: () => tunnel.alive,
                    close: () => {
                        tunnel.closed += 1;
                    }
                }
            };
        },
        driver: async () => {
            const driver = new FakeDriver();
            drivers.push(driver);
            return driver;
        }
    });
}

function address(
    userId = ALICE,
    overrides: Partial<data.DataAddress> = {}
): data.DataAddress {
    return {
        engine: "postgres",
        host: "db.internal",
        port: 5432,
        database: "app",
        username: "app",
        password: "fixture-password",
        tls: NO_TLS,
        readOnly: false,
        session: { userId, connectionId: "conn-1" },
        ...overrides
    };
}

const read = (driver: data.DataDriver) => driver.namespaces();

beforeEach(() => {
    routes = [];
    drivers = [];
    routeFails = false;
    clock = 0;
});

afterEach(() => {
    vi.useRealTimers();
});

describe("reuse", () => {
    it("opens one route and one login for a run of calls", async () => {
        const sessions = cache();
        for (let call = 0; call < 6; call += 1) await sessions.use(address(), read);

        expect(routes).toHaveLength(1);
        expect(drivers).toHaveLength(1);
        sessions.closeAll();
    });

    it("shares one route between parallel calls and caps the logins", async () => {
        const sessions = cache();
        let inFlight = 0;
        let most = 0;
        const slow = async (driver: data.DataDriver) => {
            inFlight += 1;
            most = Math.max(most, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;
            return driver.namespaces();
        };

        await Promise.all(Array.from({ length: 12 }, () => sessions.use(address(), slow)));

        expect(routes).toHaveLength(1);
        expect(drivers).toHaveLength(PER_SESSION);
        expect(most).toBe(PER_SESSION);
        sessions.closeAll();
    });

    it("refuses calls past the queue rather than holding them forever", async () => {
        const sessions = cache();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const held = (driver: data.DataDriver) => gate.then(() => driver.namespaces());

        const calls = Array.from({ length: PER_SESSION + MAX_QUEUE + 1 }, () =>
            sessions.use(address(), held).then(
                () => "done",
                (error: Error) => error.message
            )
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        release();
        const answers = await Promise.all(calls);

        expect(answers.filter((answer) => answer === SESSIONS_BUSY)).toHaveLength(1);
        expect(answers.filter((answer) => answer === "done")).toHaveLength(
            PER_SESSION + MAX_QUEUE
        );
        sessions.closeAll();
    });

    it("pings a login that sat unused before lending it again", async () => {
        const sessions = cache();
        await sessions.use(address(), read);
        clock += PING_AFTER_MS + 1;
        await sessions.use(address(), read);

        expect(drivers).toHaveLength(1);
        expect(drivers[0]?.pings).toBe(1);
        sessions.closeAll();
    });
});

describe("what is never shared or kept", () => {
    it("never shares a session between two accounts", async () => {
        const sessions = cache();
        await sessions.use(address(ALICE), read);
        await sessions.use(address(BOB), read);

        expect(routes).toHaveLength(2);
        expect(sessions.size).toBe(2);
        sessions.closeAll();
    });

    it("never reaches an old session once the connection resolves differently", async () => {
        const sessions = cache();
        await sessions.use(address(), read);
        await sessions.use(address(ALICE, { password: "rotated-fixture" }), read);
        await sessions.use(address(ALICE, { readOnly: true }), read);
        await sessions.use(address(ALICE, { database: "billing" }), read);

        expect(routes).toHaveLength(4);
        sessions.closeAll();
    });

    it("closes a connection's sessions when it is edited, and opens fresh after", async () => {
        const sessions = cache();
        await sessions.use(address(), read);
        await sessions.use(address(BOB), read);

        sessions.closeFor(ALICE, "conn-1");

        expect(routes[0]?.closed).toBe(1);
        expect(drivers[0]?.closed).toBe(1);
        // Somebody else's session of the same id is not theirs to close.
        expect(routes[1]?.closed).toBe(0);
        await sessions.use(address(), read);
        expect(routes).toHaveLength(3);
        sessions.closeAll();
    });

    it("does not pool a login a typed statement ran on", async () => {
        const sessions = cache();
        await sessions.use(address(), (driver) => driver.run("BEGIN"));
        await sessions.use(address(), read);

        expect(drivers).toHaveLength(2);
        expect(drivers[0]?.closed).toBe(1);
        expect(routes).toHaveLength(1);
        sessions.closeAll();
    });

    it("drops a login whose call failed, but keeps one that was only refused", async () => {
        const sessions = cache();
        await expect(
            sessions.use(address(), async () => {
                throw new data.DataRequestError("There is nothing here by that name.");
            })
        ).rejects.toThrow();
        await sessions.use(address(), read);
        expect(drivers).toHaveLength(1);

        await expect(
            sessions.use(address(), async () => {
                throw new Error("Connection terminated unexpectedly");
            })
        ).rejects.toThrow();
        expect(drivers[0]?.closed).toBe(1);
        await sessions.use(address(), read);
        expect(drivers).toHaveLength(2);
        sessions.closeAll();
    });

    it("hands a lent driver a close that does nothing", async () => {
        const sessions = cache();
        await sessions.use(address(), (driver) => driver.close());
        await sessions.use(address(), read);
        expect(drivers).toHaveLength(1);
        expect(drivers[0]?.closed).toBe(0);
        sessions.closeAll();
    });

    it("lets a lent driver close its own client from inside a call", async () => {
        const sessions = cache();
        await sessions.use(address(), (driver) => (driver as FakeDriver).reopen());
        expect(drivers[0]?.closed).toBe(1);
        sessions.closeAll();
    });
});

describe("closing", () => {
    it("closes an idle session after its idle time", async () => {
        vi.useFakeTimers();
        const sessions = cache();
        await sessions.use(address(), read);

        vi.advanceTimersByTime(IDLE_MS - 1);
        expect(routes[0]?.closed).toBe(0);
        vi.advanceTimersByTime(1);

        expect(routes[0]?.closed).toBe(1);
        expect(drivers[0]?.closed).toBe(1);
        expect(sessions.size).toBe(0);
    });

    it("replaces a dead tunnel once on the next call", async () => {
        const sessions = cache();
        await sessions.use(address(), read);
        routes[0]!.alive = false;

        await sessions.use(address(), read);

        expect(routes).toHaveLength(2);
        expect(routes[0]?.closed).toBe(1);
        expect(drivers[0]?.closed).toBe(1);
        sessions.closeAll();
    });

    it("does not loop when the replacement cannot open either", async () => {
        const sessions = cache();
        await sessions.use(address(), read);
        routes[0]!.alive = false;
        routeFails = true;

        await expect(sessions.use(address(), read)).rejects.toThrow("route failed");
        expect(routes).toHaveLength(1);
        expect(sessions.size).toBe(0);

        routeFails = false;
        await sessions.use(address(), read);
        expect(routes).toHaveLength(2);
        sessions.closeAll();
    });

    it("evicts an account's quietest session at its cap, and refuses when all are busy", async () => {
        const sessions = cache();
        for (let index = 0; index < MAX_PER_USER; index += 1) {
            clock += 1;
            await sessions.use(
                address(ALICE, { session: { userId: ALICE, connectionId: `conn-${index}` } }),
                read
            );
        }
        await sessions.use(
            address(ALICE, { session: { userId: ALICE, connectionId: "one-more" } }),
            read
        );
        expect(sessions.size).toBe(MAX_PER_USER);
        expect(routes[0]?.closed).toBe(1);

        sessions.closeAll();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const busy = Array.from({ length: MAX_PER_USER }, (_, index) =>
            sessions.use(
                address(ALICE, { session: { userId: ALICE, connectionId: `busy-${index}` } }),
                (driver) => gate.then(() => driver.namespaces())
            )
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        await expect(
            sessions.use(
                address(ALICE, { session: { userId: ALICE, connectionId: "refused" } }),
                read
            )
        ).rejects.toThrow(SESSIONS_BUSY);
        release();
        await Promise.all(busy);
        sessions.closeAll();
    });
});
