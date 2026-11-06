/**
 * The DNS records a game server leaves behind.
 *
 * The cases are the ones that left eight records in an operator's zone: a server
 * deleted with its SRV record still there, a provider that did not answer at the
 * moment of the delete, and the records written before any were remembered. And
 * the one that must never happen: a record Polaris did not write being removed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    ownerId: string;
    installedAppId: string;
    zoneId: string;
    recordId: string;
    type: string;
    name: string;
    releaseRequestedAt: Date | null;
    releaseError: string | null;
}

interface ZoneRecord {
    id: string;
    type: "A" | "SRV";
    name: string;
    target: string;
    port: number;
}

const state = vi.hoisted(() => ({
    rows: [] as Row[],
    installs: [] as Array<{ id: string; status: string; config: string }>,
    zone: [] as ZoneRecord[],
    token: "token" as string | null,
    failDeletes: false,
    nextId: 1,
    deletes: [] as string[]
}));

/** Just enough of a Prisma `where` for the queries the module makes. */
function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
    return Object.entries(where).every(([key, wanted]) => {
        const value = row[key];
        if (wanted === null) return value === null;
        if (typeof wanted === "object" && wanted !== null && !(wanted instanceof Date)) {
            const filter = wanted as { not?: unknown; in?: unknown[]; notIn?: unknown[] };
            if ("not" in filter) return filter.not === null ? value !== null : value !== filter.not;
            if (filter.in) return filter.in.includes(value);
            if (filter.notIn) return !filter.notIn.includes(value);
        }
        return value === wanted;
    });
}

vi.mock("@polaris/db", () => {
    const gameDnsRecord = {
        upsert: async ({
            where,
            create,
            update
        }: {
            where: { zoneId_recordId: { zoneId: string; recordId: string } };
            create: Omit<Row, "id" | "releaseRequestedAt" | "releaseError">;
            update: Partial<Row>;
        }) => {
            const key = where.zoneId_recordId;
            const found = state.rows.find(
                (row) => row.zoneId === key.zoneId && row.recordId === key.recordId
            );
            if (found) Object.assign(found, update);
            else
                state.rows.push({
                    id: `row-${state.nextId++}`,
                    releaseRequestedAt: null,
                    releaseError: null,
                    ...create
                });
        },
        updateMany: async ({
            where,
            data
        }: {
            where: Record<string, unknown>;
            data: Partial<Row>;
        }) => {
            const hit = state.rows.filter((row) => matches(row as never, where));
            hit.forEach((row) => Object.assign(row, data));
            return { count: hit.length };
        },
        deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
            const before = state.rows.length;
            state.rows = state.rows.filter((row) => !matches(row as never, where));
            return { count: before - state.rows.length };
        },
        findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
            state.rows.filter((row) => matches(row as never, where)).slice(0, take ?? Infinity),
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
            state.rows.find((row) => matches(row as never, where)) ?? null,
        count: async ({ where }: { where: Record<string, unknown> }) =>
            state.rows.filter((row) => matches(row as never, where)).length
    };
    return {
        prisma: {
            gameDnsRecord,
            installedApp: {
                findMany: async ({
                    where
                }: {
                    where: { OR?: Array<{ config: { contains: string } }> };
                }) =>
                    state.installs.filter(
                        (install) =>
                            install.status !== "removed" &&
                            (where.OR ?? []).some((clause) =>
                                install.config.includes(clause.config.contains)
                            )
                    ),
                findFirst: async ({ where }: { where: { id: string } }) => {
                    const install = state.installs.find((entry) => entry.id === where.id);
                    return install ? { applicationId: "app-1", config: install.config } : null;
                }
            },
            application: {
                findUnique: async () => ({ sourceConfig: JSON.stringify({ hostPort: 25566 }) })
            },
            // The orphan query: rows nobody asked to release whose server is gone.
            $queryRaw: async () =>
                state.rows
                    .filter((row) => row.releaseRequestedAt === null)
                    .filter((row) => {
                        const install = state.installs.find(
                            (entry) => entry.id === row.installedAppId
                        );
                        return !install || install.status === "removed";
                    })
                    .map((row) => ({ id: row.id }))
        }
    };
});

vi.mock("@polaris/app-host", () => {
    const deleteDnsRecordIfPresent = async (_token: string, _zone: string, id: string) => {
        if (state.failDeletes) throw new Error("Cloudflare unreachable: timeout");
        state.deletes.push(id);
        const before = state.zone.length;
        state.zone = state.zone.filter((record) => record.id !== id);
        return before === state.zone.length ? "absent" : "deleted";
    };
    const upsertSrvRecord = async (
        _token: string,
        _zone: string,
        name: string,
        target: string,
        port: number
    ) => {
        const found = state.zone.find((record) => record.type === "SRV" && record.name === name);
        if (found) return found.id;
        const id = `cf-${state.nextId++}`;
        state.zone.push({ id, type: "SRV", name, target, port });
        return id;
    };
    const listSrvRecordsPage = async (
        _token: string,
        _zone: string,
        filter: { startsWith: string; endsWith: string },
        page: number
    ) => {
        const all = state.zone.filter(
            (record) =>
                record.type === "SRV" &&
                record.name.startsWith(filter.startsWith) &&
                record.name.endsWith(filter.endsWith)
        );
        const records = all.slice((page - 1) * 100, page * 100);
        return { records, more: records.length >= 100 };
    };
    const provisionHostnameDns = async (hostname: string) => {
        const id = `cf-${state.nextId++}`;
        state.zone.push({ id, type: "A", name: hostname, target: "203.0.113.7", port: 0 });
        return { status: "created", ip: "203.0.113.7", recordId: id, zoneId: "zone-1" };
    };
    const patchInstallConfig = async (id: string, patch: Record<string, unknown>) => {
        const install = state.installs.find((entry) => entry.id === id);
        if (install) install.config = JSON.stringify({ ...JSON.parse(install.config), ...patch });
    };
    const readInstallConfig = (raw: string | null | undefined) => (raw ? JSON.parse(raw) : {});
    // Everything the address module reaches that these cases do not: a no-op.
    const rest = new Proxy({}, { get: () => async () => undefined });
    const known: Record<string, unknown> = {
        domainService: { getPublicIp: async () => "203.0.113.7" },
        domainZones: { getDomainZones: async () => ({ baseDomain: "example.com" }) },
        domainDns: { provisionHostnameDns },
        appsInstallConfig: { patchInstallConfig, readInstallConfig },
        integrationsCloudflareAccountService: { loadCloudflareToken: async () => state.token },
        minecraftRouter: { startRouter: async () => null, stopRouter: async () => undefined },
        integrationsCloudflareApi: {
            deleteDnsRecord: async () => undefined,
            deleteDnsRecordIfPresent,
            findDnsRecords: async () => [],
            listSrvRecordsPage,
            resolveZoneForHostname: async () => ({ id: "zone-1", name: "example.com" }),
            upsertSrvRecord
        }
    };
    return { host: new Proxy(known, { get: (target, key: string) => target[key] ?? rest }) };
});

const gameDns = await import("@polaris-app/game-servers/src/lib/game-dns");
const { setGameHostname } = await import("@polaris-app/game-servers/src/lib/minecraft/address");

const OWNER = "owner-1";

function install(id: string, config: Record<string, unknown> = {}, status = "running"): void {
    state.installs.push({ id, status, config: JSON.stringify(config) });
}

/** A SRV record exactly as a server created before this fix left it. */
function legacySrv(label: string, port = 25566, target?: string): ZoneRecord {
    const hostname = `${label}.mc.example.com`;
    const record = {
        id: `legacy-${label}`,
        type: "SRV" as const,
        name: `_minecraft._tcp.${hostname}`,
        target: target ?? hostname,
        port
    };
    state.zone.push(record);
    return record;
}

beforeEach(() => {
    state.rows = [];
    state.installs = [];
    state.zone = [];
    state.token = "token";
    state.failDeletes = false;
    state.nextId = 1;
    state.deletes = [];
});

describe("creating a server", () => {
    it("remembers the A and SRV records it wrote", async () => {
        install("srv-1");
        expect(await setGameHostname(OWNER, "srv-1", { name: "Survival", srv: true })).toBe(
            "survival.mc.example.com"
        );
        expect(state.rows.map((row) => [row.type, row.name, row.installedAppId])).toEqual([
            ["A", "survival.mc.example.com", "srv-1"],
            ["SRV", "_minecraft._tcp.survival.mc.example.com", "srv-1"]
        ]);
    });

    it("releases the old name's records on a rename, and keeps the new name's", async () => {
        install("srv-1");
        await setGameHostname(OWNER, "srv-1", { name: "test", srv: true });
        await setGameHostname(OWNER, "srv-1", { name: "test-2", srv: true });
        expect(state.zone.map((record) => record.name).sort()).toEqual([
            "_minecraft._tcp.test-2.mc.example.com",
            "test-2.mc.example.com"
        ]);
        expect(state.rows.every((row) => row.name.includes("test-2"))).toBe(true);
    });
});

describe("deleting a server", () => {
    it("removes exactly the records written for it, and is idempotent", async () => {
        install("srv-1");
        install("srv-2");
        await setGameHostname(OWNER, "srv-1", { name: "bed-wars", srv: true });
        await setGameHostname(OWNER, "srv-2", { name: "parkour", srv: true });
        expect(await gameDns.releaseGameDns("srv-1")).toEqual({ released: 2, failed: 0 });
        expect(state.zone.map((record) => record.name).sort()).toEqual([
            "_minecraft._tcp.parkour.mc.example.com",
            "parkour.mc.example.com"
        ]);
        expect(await gameDns.releaseGameDns("srv-1")).toEqual({ released: 0, failed: 0 });
    });

    it("drops the row when the record is already gone at the provider", async () => {
        install("srv-1");
        await setGameHostname(OWNER, "srv-1", { name: "demo", srv: true });
        state.zone = [];
        expect(await gameDns.releaseGameDns("srv-1")).toEqual({ released: 2, failed: 0 });
        expect(state.rows).toEqual([]);
    });

    it("never throws when the provider is down, keeps the rows marked, and the sweep finishes it", async () => {
        install("srv-1");
        await setGameHostname(OWNER, "srv-1", { name: "skyblock", srv: true });
        state.installs[0]!.status = "removed";
        state.failDeletes = true;
        expect(await gameDns.releaseGameDns("srv-1")).toEqual({ released: 0, failed: 2 });
        expect(state.rows).toHaveLength(2);
        expect(
            state.rows.every(
                (row) => row.releaseRequestedAt && row.releaseError?.includes("unreachable")
            )
        ).toBe(true);
        expect((await gameDns.gameDnsLeftovers(OWNER)).count).toBe(2);

        state.failDeletes = false;
        const sweep = await gameDns.sweepGameDns();
        expect(sweep.released).toBe(2);
        expect(state.rows).toEqual([]);
        expect(state.zone).toEqual([]);
        expect((await gameDns.gameDnsLeftovers(OWNER)).count).toBe(0);
    });

    it("says no token rather than a provider sentence when there is nothing to remove them with", async () => {
        install("srv-1");
        await setGameHostname(OWNER, "srv-1", { name: "lucky-blocks", srv: true });
        state.token = null;
        await gameDns.releaseGameDns("srv-1");
        expect(await gameDns.gameDnsLeftovers(OWNER)).toEqual({
            count: 2,
            reason: gameDns.NO_TOKEN
        });
    });

    it("releases the records of a server whose delete crashed before asking", async () => {
        install("srv-1");
        await setGameHostname(OWNER, "srv-1", { name: "offgrid", srv: true });
        state.installs[0]!.status = "removed";
        await gameDns.sweepGameDns();
        expect(state.zone).toEqual([]);
    });
});

describe("the sweep over records written before any were remembered", () => {
    it("removes the leftovers of deleted servers and nothing else", async () => {
        const leftovers = [
            "bed-wars",
            "parkour",
            "test-2",
            "test",
            "demo",
            "lucky-blocks",
            "skyblock",
            "offgrid"
        ];
        leftovers.forEach((label, index) => legacySrv(label, 25565 + (index % 5)));
        // A live server keeps its record.
        install("live", { hostname: "survival.mc.example.com" });
        legacySrv("survival");
        // A deleted server's name is free again, so its record goes.
        install("gone", { hostname: "old.mc.example.com" }, "removed");
        legacySrv("old");
        // Shapes Polaris never writes: another target, a deeper name, another game's
        // label, the zone's own service records.
        legacySrv("external", 25565, "play.elsewhere.net");
        state.zone.push({
            id: "deep",
            type: "SRV",
            name: "_minecraft._tcp.a.b.mc.example.com",
            target: "a.b.mc.example.com",
            port: 25565
        });
        state.zone.push({
            id: "sip",
            type: "SRV",
            name: "_sip._tcp.example.com",
            target: "sip.example.com",
            port: 5060
        });
        state.zone.push({
            id: "wild",
            type: "A",
            name: "*.mc.example.com",
            target: "203.0.113.7",
            port: 0
        });

        const sweep = await gameDns.sweepGameDns();
        expect(sweep.legacyRemoved).toBe(9);
        expect(state.zone.map((record) => record.id).sort()).toEqual(
            ["deep", "legacy-external", "legacy-survival", "sip", "wild"].sort()
        );
    });

    it("walks a zone larger than one page", async () => {
        for (let index = 0; index < 250; index += 1) legacySrv(`s${index}`);
        expect((await gameDns.sweepGameDns()).legacyRemoved).toBe(250);
        expect(state.zone).toEqual([]);
    });

    it("leaves a record a row remembers to the rows", async () => {
        install("srv-1");
        await setGameHostname(OWNER, "srv-1", { name: "kept", srv: true });
        // The live server's name is in its config; even with it gone from there,
        // a remembered record is released only through its row.
        state.installs[0]!.config = "{}";
        const before = state.zone.length;
        expect(await gameDns.sweepLegacySrv()).toBe(0);
        expect(state.zone).toHaveLength(before);
    });
});

describe("legacyGameSrvHostname", () => {
    it("accepts only the exact shape Polaris writes", () => {
        const base = "example.com";
        expect(
            gameDns.legacyGameSrvHostname(
                { name: "_minecraft._tcp.test.mc.example.com", target: "test.mc.example.com." },
                base
            )
        ).toBe("test.mc.example.com");
        expect(
            gameDns.legacyGameSrvHostname(
                { name: "_minecraft._tcp.test.mc.example.com", target: "other.example.com" },
                base
            )
        ).toBeNull();
        expect(
            gameDns.legacyGameSrvHostname(
                { name: "_minecraft._tcp.test.ark.example.com", target: "test.ark.example.com" },
                base
            )
        ).toBeNull();
        expect(
            gameDns.legacyGameSrvHostname(
                { name: "_minecraft._tcp.test.mc.example.org", target: "test.mc.example.org" },
                base
            )
        ).toBeNull();
        expect(
            gameDns.legacyGameSrvHostname(
                { name: "_minecraft._tcp.mc.example.com", target: "mc.example.com" },
                base
            )
        ).toBeNull();
    });
});
