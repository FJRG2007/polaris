/**
 * The pages the game-server pickers read: the machines a new server can run on
 * and the servers an automation step can act on.
 *
 * Both are the reader's own (or granted) rows only, a page at a time in name
 * order, and a page costs a query - never an SSH session per machine.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "owner-1";
const MACHINE = "0b6c1f1e-4b8e-4a3a-9a63-6f1c2e9d1a01";

const installedFind = vi.fn(async (_args: Record<string, unknown>) => [] as unknown[]);

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: { findMany: (args: Record<string, unknown>) => installedFind(args) },
        deployTarget: { findMany: async () => [] }
    }
}));

const readServerOptions = vi.fn(async (_owner: string, _request: Record<string, unknown>) => ({
    items: [
        {
            id: MACHINE,
            name: "rack",
            address: "192.0.2.20",
            os: null,
            environment: "home",
            root: true,
            online: true
        }
    ],
    next: "cursor-2"
}));

vi.mock("@/lib/server-options", () => ({
    readServerOptions: (owner: string, request: Record<string, unknown>) =>
        readServerOptions(owner, request)
}));

const getServerMetrics = vi.fn(async (_id: string, _owner: string) => ({
    memoryTotalBytes: 8,
    memoryUsedBytes: 3
}));
const peekServerMetrics = vi.fn(async (_id: string) => null);

vi.mock("@/lib/server-metrics-service", () => ({
    getServerMetrics: (id: string, owner: string) => getServerMetrics(id, owner),
    peekServerMetrics: (id: string) => peekServerMetrics(id)
}));

const service = await import("@polaris-app/game-servers/src/lib/games-service");

beforeEach(() => {
    installedFind.mockClear();
    readServerOptions.mockClear();
    getServerMetrics.mockClear();
    peekServerMetrics.mockClear();
});

describe("gameMachinePage", () => {
    it("reads the owner's servers a page at a time without measuring any", async () => {
        const page = await service.gameMachinePage(OWNER, { query: "", cursor: "cursor-1" });
        expect(readServerOptions).toHaveBeenCalledWith(
            OWNER,
            expect.objectContaining({ cursor: "cursor-1", limit: service.GAME_MACHINE_PAGE })
        );
        expect(getServerMetrics).not.toHaveBeenCalled();
        expect(page.items.map((item) => item.id)).toEqual([MACHINE]);
        expect(page.next).toBe("cursor-2");
    });

    it("offers this machine first on the first page only", async () => {
        const first = await service.gameMachinePage(OWNER, { query: "", cursor: null });
        expect(first.items.map((item) => item.id)).toEqual(["local", MACHINE]);
        const searched = await service.gameMachinePage(OWNER, { query: "rack", cursor: null });
        expect(searched.items.map((item) => item.id)).toEqual([MACHINE]);
    });

    it("measures only the machine chosen", async () => {
        const machine = await service.measuredGameMachine(OWNER, MACHINE);
        expect(getServerMetrics).toHaveBeenCalledTimes(1);
        expect(getServerMetrics).toHaveBeenCalledWith(MACHINE, OWNER);
        expect(machine).toMatchObject({ id: MACHINE, memoryTotalBytes: 8, memoryFreeBytes: 5 });
    });

    it("answers nothing for a machine that is not the owner's", async () => {
        readServerOptions.mockResolvedValueOnce({ items: [], next: null });
        expect(await service.measuredGameMachine(OWNER, MACHINE)).toBeNull();
        expect(getServerMetrics).not.toHaveBeenCalled();
    });
});

describe("gameServerOptionsPage", () => {
    it("reads own and granted game servers by name, one past the page", async () => {
        installedFind.mockResolvedValueOnce([
            { id: "a", name: "alpha" },
            { id: "b", name: "beta" }
        ]);
        const page = await service.gameServerOptionsPage(OWNER, ["granted-1"], {
            query: "a",
            cursor: null,
            limit: 1
        });
        const args = installedFind.mock.calls[0]![0] as {
            where: { AND: Record<string, unknown>[] };
            take: number;
            orderBy: unknown;
        };
        expect(args.take).toBe(2);
        expect(args.orderBy).toEqual([{ name: "asc" }, { id: "asc" }]);
        expect(args.where.AND[0]).toEqual({
            OR: [
                { ownerId: OWNER, status: { not: "removed" } },
                { id: { in: ["granted-1"] }, status: { not: "removed" } }
            ]
        });
        expect(args.where.AND).toContainEqual({ name: { contains: "a", mode: "insensitive" } });
        expect(page.items).toEqual([{ id: "a", name: "alpha" }]);
        expect(page.next).not.toBeNull();

        installedFind.mockResolvedValueOnce([]);
        await service.gameServerOptionsPage(OWNER, [], { query: "", cursor: page.next, limit: 1 });
        const next = installedFind.mock.calls[1]![0] as { where: { AND: unknown[] } };
        expect(next.where.AND[0]).toEqual({ ownerId: OWNER, status: { not: "removed" } });
        expect(next.where.AND).toContainEqual({
            OR: [{ name: { gt: "alpha" } }, { name: "alpha", id: { gt: "a" } }]
        });
    });
});
