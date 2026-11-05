/**
 * The servers the security scans picker reads, a page at a time: searched and
 * ordered by name in the database, continued on (name, id), and never more
 * than one row past the page.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn(async (_args: Record<string, unknown>) => [] as unknown[]);

vi.mock("@polaris/db", () => ({
    prisma: { deployTarget: { findMany: (args: Record<string, unknown>) => findMany(args) } }
}));

vi.mock("@polaris/app-host", () => ({ host: {} }));

vi.mock("@polaris-app/security-scans/src/lib/runner", () => ({
    ScanFailure: class ScanFailure extends Error {},
    TIMEOUT_MS: 60 * 60_000
}));

const { listServers } = await import("@polaris-app/security-scans/src/lib/service");

function target(id: string, name: string) {
    return {
        id,
        name,
        kind: id === "a" ? "local" : "ssh",
        securitySetting: id === "a" ? { everyHours: 6, updates: "none", distro: "debian" } : null
    };
}

beforeEach(() => findMany.mockReset());

describe("listServers", () => {
    it("reads one page in name order with each server's scan settings", async () => {
        findMany.mockResolvedValueOnce([target("a", "alpha"), target("b", "beta")]);
        const page = await listServers({ query: "a", cursor: null, limit: 1 });
        const args = findMany.mock.calls[0]![0] as {
            where: { AND: unknown[] };
            take: number;
            orderBy: unknown;
        };
        expect(args.take).toBe(2);
        expect(args.orderBy).toEqual([{ name: "asc" }, { id: "asc" }]);
        expect(args.where.AND).toEqual([{ name: { contains: "a", mode: "insensitive" } }]);
        expect(page.items).toEqual([
            {
                id: "a",
                name: "alpha",
                local: true,
                everyHours: 6,
                updates: "none",
                distro: "debian"
            }
        ]);
        expect(page.next).not.toBeNull();

        findMany.mockResolvedValueOnce([target("b", "beta")]);
        const next = await listServers({ query: "", cursor: page.next, limit: 1 });
        const second = findMany.mock.calls[1]![0] as { where: { AND: unknown[] } };
        expect(second.where.AND).toEqual([
            { OR: [{ name: { gt: "alpha" } }, { name: "alpha", id: { gt: "a" } }] }
        ]);
        expect(next).toMatchObject({ items: [{ id: "b", everyHours: 0 }], next: null });
    });

    it("reads servers back by id", async () => {
        findMany.mockResolvedValueOnce([]);
        const page = await listServers({ query: "", cursor: null, limit: 50, ids: ["gone"] });
        const args = findMany.mock.calls[0]![0] as { where: { AND: unknown[] } };
        expect(args.where.AND).toEqual([{ id: { in: ["gone"] } }]);
        expect(page).toEqual({ items: [], next: null });
    });
});
