/**
 * The Places machines list a page at a time: servers in (name, id) order with
 * the machine Polaris runs on only on the first page, and domains continued on
 * their hostname - never more than one row past the page.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const hostFindMany = vi.fn(async (_args: Record<string, unknown>) => [] as unknown[]);
const domainFindMany = vi.fn(async (_args: Record<string, unknown>) => [] as unknown[]);

vi.mock("@polaris/db", () => ({
    prisma: {
        host: { findMany: (args: Record<string, unknown>) => hostFindMany(args) },
        domain: { findMany: (args: Record<string, unknown>) => domainFindMany(args) },
        alarm: { findMany: async () => [] },
        metricSample: { findMany: async () => [] }
    }
}));

vi.mock("@/lib/local-machine", () => ({
    localMachineIdentity: async () => ({
        hostId: "00000000-0000-4000-8000-000000000999",
        dockerId: null,
        addresses: new Set(["127.0.0.1"])
    }),
    isLocalMachine: (host: { id?: string }) => host.id === "00000000-0000-4000-8000-000000000999"
}));
vi.mock("@/lib/local-server", () => ({
    LOCAL_SERVER_ID: "local",
    localServerName: async (name?: string) => name ?? "This machine"
}));
vi.mock("@/lib/deploy-service", () => ({ inFlightDeployments: async () => [] }));
vi.mock("@/lib/docker-service", () => ({
    hostDockerDriver: vi.fn(),
    localDockerDriver: vi.fn(),
    HOST_DOCKER_PREFIX: "host:",
    LOCAL_DOCKER_CONNECTION_ID: "local"
}));
vi.mock("@/lib/container-stats-cache", () => ({
    cachedSamples: () => new Map(),
    oldestSampleAt: () => null,
    refreshSamples: vi.fn(),
    STATS_TTL_MS: 1
}));
vi.mock("@/lib/access/grants", () => ({ grantedSubjects: async () => new Map() }));

const { machineDomainPage, machineServerPage, SERVER_PAGE, DOMAIN_PAGE } = await import(
    "@/lib/machines/machines-service"
);
const { getWatchServerPage } = await import("@/lib/watch-overview-service");

/** Host ids are uuids, as the cursor requires. */
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LOCAL = uid(999);

const host = (id: string, name: string) => ({
    id,
    name,
    address: `10.0.0.${id.length}`,
    username: "root",
    dockerId: null
});

beforeEach(() => {
    hostFindMany.mockReset();
    domainFindMany.mockReset();
});

describe("machineServerPage", () => {
    it("reads one page past the limit by name, the local machine first and once", async () => {
        const rows = Array.from({ length: SERVER_PAGE + 1 }, (_, i) =>
            host(uid(i), `srv-${String(i).padStart(2, "0")}`)
        );
        rows[1] = host(LOCAL, "srv-01");
        hostFindMany.mockImplementation(async (args) =>
            (args.take as number) === 5 ? [host(LOCAL, "Home box")] : rows
        );
        const page = await machineServerPage("owner", null);
        const paging = hostFindMany.mock.calls.find((call) => call[0].take !== 5)![0];
        expect(paging.take).toBe(SERVER_PAGE + 1);
        expect(paging.orderBy).toEqual([{ name: "asc" }, { id: "asc" }]);
        expect(page.items[0]!.name).toBe("Home box");
        // The local row is the machine card, not a second server card.
        expect(page.items.filter((card) => card.id === LOCAL)).toEqual([]);
        expect(page.items).toHaveLength(SERVER_PAGE);
        expect(page.next).not.toBeNull();

        hostFindMany.mockReset();
        hostFindMany.mockResolvedValueOnce([host(uid(99), "zz")]);
        const second = await machineServerPage("owner", page.next);
        expect(hostFindMany).toHaveBeenCalledTimes(1);
        const where = hostFindMany.mock.calls[0]![0].where as { OR: unknown[] };
        expect(where.OR).toEqual([
            { name: { gt: "srv-23" } },
            { name: "srv-23", id: { gt: uid(23) } }
        ]);
        expect(second.items.map((card) => card.name)).toEqual(["zz"]);
        expect(second.next).toBeNull();
    });
});

describe("getWatchServerPage", () => {
    it("links every server by id, so an address never depends on the page", async () => {
        // "zz" is unique on this page, but a namesake may sort onto another one.
        hostFindMany.mockImplementation(async (args) =>
            (args.take as number) === 5 ? [host(LOCAL, "Home box")] : [host(uid(7), "zz")]
        );
        const first = await getWatchServerPage("owner", null, 2);
        expect(first.cards.map((card) => card.href)).toEqual([
            `/watch/server/${LOCAL}`,
            `/watch/server/${uid(7)}`
        ]);
    });
});

describe("machineDomainPage", () => {
    const domain = (id: string, hostname: string) => ({
        id,
        hostname,
        healthStatus: "up",
        healthCode: 200,
        healthLatencyMs: 10,
        healthDetail: null,
        healthCheckedAt: null,
        application: { id: "app", name: "web", environment: { projectId: "p" } }
    });

    it("pages the owner's domains by hostname", async () => {
        domainFindMany.mockResolvedValueOnce(
            Array.from({ length: DOMAIN_PAGE + 1 }, (_, i) => domain(`d${i}`, `a${1000 + i}.test`))
        );
        const page = await machineDomainPage("owner", null);
        const args = domainFindMany.mock.calls[0]![0] as { take: number; where: unknown };
        expect(args.take).toBe(DOMAIN_PAGE + 1);
        expect(args.where).toEqual({
            application: { environment: { project: { ownerId: "owner" } } }
        });
        expect(page.items).toHaveLength(DOMAIN_PAGE);

        domainFindMany.mockResolvedValueOnce([]);
        await machineDomainPage("owner", page.next);
        const next = domainFindMany.mock.calls[1]![0] as { where: Record<string, unknown> };
        expect(next.where.hostname).toEqual({ gt: `a${1000 + DOMAIN_PAGE - 1}.test` });
    });

    it("treats a cursor that is not one as the first page", async () => {
        domainFindMany.mockResolvedValueOnce([]);
        await machineDomainPage("owner", "garbage");
        const args = domainFindMany.mock.calls[0]![0] as { where: Record<string, unknown> };
        expect(args.where.hostname).toBeUndefined();
    });
});
