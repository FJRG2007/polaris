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

import { beforeEach, describe, expect, it, vi } from "vitest";

/** The Setting table, with the write shapes the sweep relies on. */
const rows = new Map<string, string>();

interface KeyWhere {
    key?: string | { startsWith?: string; in?: string[]; };
    value?: { startsWith: string; };
    NOT?: { value?: { startsWith: string; }; key?: { in: string[]; }; };
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
    findMany: vi.fn(async ({ where }: { where: KeyWhere; }) =>
        [...rows].filter(([key]) => matches(key, where)).map(([key, value]) => ({ key, value }))
    ),
    create: vi.fn(async ({ data }: { data: { key: string; value: string; }; }) => {
        if (rows.has(data.key)) throw new Error("Unique constraint failed on the fields: (`key`)");
        rows.set(data.key, data.value);
        return data;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: KeyWhere; data: { value: string; }; }) => {
        const keys = [...rows.keys()].filter((key) => matches(key, where));
        for (const key of keys) rows.set(key, data.value);
        return { count: keys.length };
    }),
    deleteMany: vi.fn(async ({ where }: { where: KeyWhere; }) => {
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

const notify = vi.fn(async () => {});
const stopPolarisTunnel = vi.fn(async () => {
    rows.delete("polaris.ptunnel.url");
    addresses = addresses.filter((address) => address.kind !== "tunnel");
});
const checkDomain = vi.fn(async ({ hostname }: { hostname: string; }) =>
    answering.has(hostname)
        ? { status: "up" as const, code: 200, latencyMs: 5, detail: null }
        : { status: "down" as const, code: null, latencyMs: 6000, detail: "Timed out" }
);

vi.mock("@polaris/db", () => ({ prisma: { setting } }));
vi.mock("@polaris/auth", () => ({ usersWithPermission: async () => ["user-1", "user-2"] }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: (input: unknown) => notify(input as never) }));
vi.mock("@/lib/deployment-addresses", () => ({ reachableAddresses: async () => addresses }));
vi.mock("@/lib/watch/health-probe", () => ({ checkDomain: (target: { hostname: string; }) => checkDomain(target) }));
vi.mock("@/lib/polaris-tunnel-service", () => ({
    getPolarisTunnelStatus: async () => ({ running: tunnelRunning, url: tunnelRunning ? TUNNEL : null }),
    stopPolarisTunnel: () => stopPolarisTunnel()
}));

const { checkedAddresses, sweepAddresses } = await import("../../src/lib/address-health");

/** A sweep, with the retry's wait fast-forwarded rather than waited out. */
async function sweep(): Promise<void> {
    const running = sweepAddresses();
    await vi.advanceTimersByTimeAsync(10_000);
    await running;
}

/** Every alert raised so far. */
function alerts(): { title: string; body: string; }[] {
    return notify.mock.calls.map(([input]) => input as unknown as { title: string; body: string; });
}

beforeEach(() => {
    vi.useFakeTimers();
    rows.clear();
    notify.mockClear();
    stopPolarisTunnel.mockClear();
    checkDomain.mockClear();
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
        expect(checkDomain.mock.calls.map(([target]) => target.hostname)).not.toContain("polaris.local");
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
        expect((await checkedAddresses()).find((address) => address.kind === "domain")?.health.state).toBe("up");
    });

    it("says when an address comes back", async () => {
        answering.delete("polaris.example.com");
        await sweep();
        notify.mockClear();

        answering.add("polaris.example.com");
        await sweep();
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
