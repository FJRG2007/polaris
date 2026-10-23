/**
 * Checking that the addresses a deployment lists still answer.
 *
 * The rules worth pinning down are the ones a single sweep cannot show. An outage
 * is announced once however many passes run and however many containers are
 * serving, because the state lives in a conditional write and not in a process. A
 * single failed request is not an outage, so a name that answers on the retry is
 * never reported at all. And what happens to a dead address depends on what it is:
 * a quick tunnel whose sidecar is gone is forgotten - it can never come back, and
 * it is what share links point at - while a domain an operator configured is only
 * ever marked, never removed.
 */

import { conditionStore } from "../notifications/fixtures/condition-store";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The Setting table, with the write shapes the sweep relies on. */
const rows = new Map<string, string>();

interface KeyWhere {
    key?: string | { startsWith?: string; in?: string[] };
    value?: { startsWith: string };
    NOT?: { value?: { startsWith: string }; key?: { in: string[] } };
}

function matches(key: string, where: KeyWhere): boolean {
    if (typeof where.key === "string" && key !== where.key) return false;
    if (typeof where.key === "object") {
        if (where.key.startsWith && !key.startsWith(where.key.startsWith)) return false;
        if (where.key.in && !where.key.in.includes(key)) return false;
    }
    const current = rows.get(key);
    if (where.value && !current?.startsWith(where.value.startsWith)) return false;
    if (where.NOT?.value && current?.startsWith(where.NOT.value.startsWith)) return false;
    if (where.NOT?.key?.in.includes(key)) return false;
    return true;
}

const setting = {
    findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
        rows.has(where.key) ? { value: rows.get(where.key) } : null
    ),
    upsert: vi.fn(
        async ({
            where,
            create,
            update
        }: {
            where: { key: string };
            create: { value: string };
            update: { value: string };
        }) => {
            rows.set(where.key, rows.has(where.key) ? update.value : create.value);
            return {};
        }
    ),
    findMany: vi.fn(async ({ where }: { where: KeyWhere }) =>
        [...rows].filter(([key]) => matches(key, where)).map(([key, value]) => ({ key, value }))
    ),
    create: vi.fn(async ({ data }: { data: { key: string; value: string } }) => {
        if (rows.has(data.key)) throw new Error("Unique constraint failed on the fields: (`key`)");
        rows.set(data.key, data.value);
        return data;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: KeyWhere; data: { value: string } }) => {
        const keys = [...rows.keys()].filter((key) => matches(key, where));
        for (const key of keys) rows.set(key, data.value);
        return { count: keys.length };
    }),
    deleteMany: vi.fn(async ({ where }: { where: KeyWhere }) => {
        const keys = [...rows.keys()].filter((key) => matches(key, where));
        for (const key of keys) rows.delete(key);
        return { count: keys.length };
    })
};

interface Address {
    url: string;
    host: string;
    kind: "app" | "local" | "domain" | "tunnel";
}

const TUNNEL = "https://ready-cat-9.trycloudflare.com";
const DOMAIN = "https://polaris.example.com";

let addresses: Address[] = [];
/** Hosts that answer. Anything else times out, as a dead name does. */
let answering = new Set<string>();
let tunnelRunning = true;

// The dispatcher is mocked, but a condition still lands in an in-memory table
// through the real service, so a recovery can be seen closing its notice.
const bell = vi.hoisted(() => ({
    store: null as ReturnType<typeof import("../notifications/fixtures/condition-store").conditionStore> | null
}));
const notify = vi.fn(async (input: { condition?: string; event?: string; userId?: string }) => {
    if (!input.condition) return;
    const { raiseCondition } = await import("@/lib/notification-service");
    await raiseCondition(input.condition, { ...(input as never), type: input.event! });
});
const stopPolarisTunnel = vi.fn(async () => {
    rows.delete("polaris.ptunnel.url");
    addresses = addresses.filter((address) => address.kind !== "tunnel");
});
const checkDomain = vi.fn(async ({ hostname }: { hostname: string }) =>
    answering.has(hostname)
        ? { status: "up" as const, code: 200, latencyMs: 5, detail: null }
        : { status: "down" as const, code: null, latencyMs: 6000, detail: "Timed out" }
);

vi.mock("@polaris/db", () => ({
    prisma: {
        setting,
        notification: {
            updateMany: (args: never) => bell.store!.notification.updateMany(args),
            create: (args: never) => bell.store!.notification.create(args),
            findMany: (args: never) => bell.store!.notification.findMany(args)
        }
    }
}));
vi.mock("@/lib/shelf", () => ({ shelfFilter: () => ({}) }));
vi.mock("@polaris/auth", () => ({ usersWithPermission: async () => ["user-1", "user-2"] }));
vi.mock("@/lib/notifications/dispatch", () => ({
    notify: (input: unknown) => notify(input as never)
}));
vi.mock("@/lib/deployment-addresses", () => ({ reachableAddresses: async () => addresses }));
vi.mock("@/lib/domain-health-probe", () => ({
    checkDomain: (target: { hostname: string }) => checkDomain(target)
}));
vi.mock("@/lib/polaris-tunnel-service", () => ({
    getPolarisTunnelStatus: async () => ({
        running: tunnelRunning,
        url: tunnelRunning ? TUNNEL : null
    }),
    stopPolarisTunnel: () => stopPolarisTunnel()
}));

/** Whether the public resolvers answer, as the offline alert asks. */
let online = true;
vi.mock("@/lib/internet-reach", () => ({ hasInternet: async () => online }));

/** What each pass told the outage record (outage-tracker.test.ts owns the rest). */
const recordPass = vi.fn(async (_observation: unknown) => ({ closely: false }));
vi.mock("@/lib/connectivity/outage-tracker", () => ({
    recordPass: (observation: unknown) => recordPass(observation)
}));

// Settling the public tunnel is its own concern (share-tunnel.test.ts).
vi.mock("@/lib/public-reach", () => ({ settleShareTunnel: async () => "unchanged" }));

const { checkConnectivityNow, checkedAddresses, sweepAddresses } =
    await import("../../src/lib/address-health");

/** A sweep, with the retry's wait fast-forwarded rather than waited out. */
async function sweep(): Promise<void> {
    const running = sweepAddresses();
    await vi.advanceTimersByTimeAsync(10_000);
    await running;
}

/** Every alert raised so far. */
function alerts(): { title: string; body: string }[] {
    return notify.mock.calls.map(([input]) => input as unknown as { title: string; body: string });
}

beforeEach(() => {
    vi.useFakeTimers();
    rows.clear();
    bell.store = conditionStore();
    notify.mockClear();
    stopPolarisTunnel.mockClear();
    checkDomain.mockClear();
    recordPass.mockClear();
    online = true;
    tunnelRunning = true;
    addresses = [
        { url: "http://polaris.local", host: "polaris.local", kind: "app" },
        { url: DOMAIN, host: "polaris.example.com", kind: "domain" },
        { url: TUNNEL, host: "ready-cat-9.trycloudflare.com", kind: "tunnel" }
    ];
    answering = new Set(["polaris.example.com", "ready-cat-9.trycloudflare.com"]);
});

describe("probing what a deployment answers on", () => {
    it("says nothing while every address works", async () => {
        await sweep();
        await sweep();
        expect(notify).not.toHaveBeenCalled();
    });

    it("leaves the local names alone, which only resolve on the operator's machine", async () => {
        await sweep();
        expect(checkDomain.mock.calls.map(([target]) => target.hostname)).not.toContain(
            "polaris.local"
        );
    });

    it("reports an address that stopped answering, once, however many passes run", async () => {
        answering.delete("polaris.example.com");
        await sweep();
        await sweep();
        await sweep();

        // Two people who can act on it, one outage: two alerts and no repeats.
        expect(alerts()).toHaveLength(2);
        expect(alerts()[0]?.title).toContain("polaris.example.com is not answering");
        expect(alerts()[0]?.body).toContain("Timed out");
    });

    it("ignores a single failed request, which is not an outage", async () => {
        // Down on the first attempt, up on the retry.
        checkDomain.mockImplementationOnce(async () => ({
            status: "down" as const,
            code: null,
            latencyMs: 6000,
            detail: "Timed out"
        }));
        await sweep();
        expect(notify).not.toHaveBeenCalled();
        expect(
            (await checkedAddresses()).find((address) => address.kind === "domain")?.health.state
        ).toBe("up");
    });

    it("says when an address comes back", async () => {
        answering.delete("polaris.example.com");
        await sweep();
        notify.mockClear();

        answering.add("polaris.example.com");
        await sweep();
        await sweep();
        // No second notice: the one that said it was down now says it is back.
        expect(alerts()).toHaveLength(0);
        const notices = bell.store!.rows;
        expect(notices).toHaveLength(2);
        for (const notice of notices) {
            expect(notice.title).toContain("answering again");
            expect(notice).toMatchObject({ level: "success", conditionKey: null, actionRequired: false });
        }
    });

    it("tells addresses that fail and come back together as one notice each way", async () => {
        addresses.push({ url: "https://plr.example.com", host: "plr.example.com", kind: "domain" });
        addresses.push({ url: "https://mc.example.com", host: "mc.example.com", kind: "domain" });
        answering.delete("polaris.example.com");
        await sweep();
        await sweep();
        const forOne = () => bell.store!.rows.filter((row) => row.userId === "user-1");
        expect(forOne()).toHaveLength(1);
        expect(forOne()[0]?.title).toBe("3 addresses are not answering");

        answering.add("polaris.example.com");
        answering.add("plr.example.com");
        answering.add("mc.example.com");
        await sweep();
        expect(forOne()).toHaveLength(1);
        expect(forOne()[0]?.title).toBe("3 addresses answer again");
        expect(forOne()[0]?.body).toBe("polaris.example.com, plr.example.com, mc.example.com are reachable again.");
    });

    it("keeps a group open, rewritten, while part of it is still down", async () => {
        addresses.push({ url: "https://plr.example.com", host: "plr.example.com", kind: "domain" });
        answering.delete("polaris.example.com");
        await sweep();
        answering.add("polaris.example.com");
        await sweep();
        const mine = bell.store!.rows.filter((row) => row.userId === "user-1");
        expect(mine).toHaveLength(1);
        expect(mine[0]).toMatchObject({ title: "plr.example.com is not answering", conditionKey: "network.address:plr.example.com" });
    });

    it("announces a recovery nothing had announced as one notice for the pass", async () => {
        answering.delete("polaris.example.com");
        await sweep();
        bell.store!.rows.length = 0;
        notify.mockClear();
        answering.add("polaris.example.com");
        await sweep();
        expect(alerts()).toHaveLength(2);
        expect(alerts()[0]?.title).toContain("answering again");
    });
});

describe("what happens to a dead address", () => {
    it("drops a tunnel URL whose tunnel is gone, and says so", async () => {
        answering.delete("ready-cat-9.trycloudflare.com");
        tunnelRunning = false;
        await sweep();

        expect(stopPolarisTunnel).toHaveBeenCalledTimes(1);
        expect(alerts()[0]?.title).toContain("tunnel address is gone");
        // Gone from the list, and nothing left behind that would report it again.
        expect(await checkedAddresses()).toHaveLength(2);
        expect([...rows.keys()]).not.toContain("address.health.ready-cat-9.trycloudflare.com");
    });

    it("keeps a tunnel that is still running, and only marks it", async () => {
        answering.delete("ready-cat-9.trycloudflare.com");
        await sweep();

        expect(stopPolarisTunnel).not.toHaveBeenCalled();
        expect(alerts()[0]?.title).toContain("is not answering");
        const tunnel = (await checkedAddresses()).find((address) => address.kind === "tunnel");
        expect(tunnel?.health.state).toBe("down");
        expect(tunnel?.health.detail).toBe("Timed out");
    });

    it("never removes a domain an operator configured", async () => {
        answering.delete("polaris.example.com");
        await sweep();
        await sweep();

        const domain = (await checkedAddresses()).find((address) => address.kind === "domain");
        expect(domain?.health.state).toBe("down");
        expect(await checkedAddresses()).toHaveLength(3);
    });

    it("forgets what it knew about an address that is no longer listed", async () => {
        answering.delete("polaris.example.com");
        await sweep();
        expect([...rows.keys()]).toContain("address.health.polaris.example.com");

        addresses = addresses.filter((address) => address.kind !== "domain");
        await sweep();
        expect([...rows.keys()]).not.toContain("address.health.polaris.example.com");
    });
});

describe("what a pass tells the outage record", () => {
    it("says the connection is up when any address answered", async () => {
        answering.delete("ready-cat-9.trycloudflare.com");
        await sweep();
        expect(recordPass).toHaveBeenLastCalledWith({ up: true, via: "polaris.example.com" });
    });

    it("says the line is down when nothing answered and the resolvers are silent too", async () => {
        answering.clear();
        online = false;
        await sweep();
        expect(recordPass).toHaveBeenLastCalledWith(
            expect.objectContaining({ up: false, kind: "line", detectedBy: "polaris.example.com" })
        );
        expect(alerts()[0]?.title).toBe("Polaris cannot reach the internet");
    });

    it("says it is the address when the line works", async () => {
        answering.clear();
        await sweep();
        expect(recordPass).toHaveBeenLastCalledWith(
            expect.objectContaining({ up: false, kind: "address" })
        );
    });
});

describe("a pass that never finishes", () => {
    it("is given up on, so the next pass still runs", async () => {
        checkDomain.mockImplementationOnce(() => new Promise(() => {}));
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        const stuck = checkConnectivityNow();
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        await stuck;
        errors.mockRestore();

        recordPass.mockClear();
        const next = checkConnectivityNow();
        await vi.advanceTimersByTimeAsync(10_000);
        await next;
        expect(recordPass).toHaveBeenCalledTimes(1);
    });

    it("gives no verdict when every listed address failed to be checked", async () => {
        checkDomain.mockRejectedValue(new Error("boom"));
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        await sweep();
        errors.mockRestore();
        checkDomain.mockReset();
        expect(recordPass).not.toHaveBeenCalled();
    });
});

describe("an address answering again", () => {
    it("says how long it was down", async () => {
        answering.delete("polaris.example.com");
        await sweep();
        notify.mockClear();

        await vi.advanceTimersByTimeAsync(25 * 60_000);
        answering.add("polaris.example.com");
        await sweep();
        const back = bell.store!.rows[0]!;
        expect(back.title).toContain("answering again");
        expect(back.body).toMatch(/is reachable again, after 25 min down\./);
    });

    it("forgets when a removed address changed, with its health", async () => {
        answering.delete("polaris.example.com");
        await sweep();
        expect([...rows.keys()]).toContain("address.since.polaris.example.com");
        addresses = addresses.filter((address) => address.kind !== "domain");
        await sweep();
        expect([...rows.keys()]).not.toContain("address.since.polaris.example.com");
    });
});
