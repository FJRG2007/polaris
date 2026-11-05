/**
 * The deployed addresses a check can point at, read a page at a time: searched
 * by hostname or app name in the database, continued on the hostname, release
 * hostnames and disabled ones left out.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn(async (_args: Record<string, unknown>) => [] as unknown[]);

vi.mock("@polaris/db", () => ({
    prisma: { domain: { findMany: (args: Record<string, unknown>) => findMany(args) } }
}));

vi.mock("@polaris/app-host", () => ({ host: {} }));

const { deployedTargets } = await import("@polaris-app/status-pages/src/lib/manage");

function domain(hostname: string, https = true) {
    return { hostname, https, application: { name: "Shop" } };
}

beforeEach(() => findMany.mockReset());

describe("deployedTargets", () => {
    it("reads one page past the limit and continues on the last hostname", async () => {
        findMany.mockResolvedValueOnce([domain("a.example.test"), domain("b.example.test")]);
        const page = await deployedTargets({ query: "shop", cursor: null, limit: 1 });
        const args = findMany.mock.calls[0]![0] as { where: Record<string, unknown>; take: number };
        expect(args.take).toBe(2);
        expect(args.where).toMatchObject({ enabled: true, NOT: { kind: "release" } });
        expect(args.where.OR).toEqual([
            { hostname: { contains: "shop", mode: "insensitive" } },
            { application: { name: { contains: "shop", mode: "insensitive" } } }
        ]);
        expect(page).toEqual({
            items: [{ id: "https://a.example.test/", name: "Shop (a.example.test)" }],
            next: "a.example.test"
        });

        findMany.mockResolvedValueOnce([domain("b.example.test", false)]);
        const next = await deployedTargets({ query: "", cursor: page.next, limit: 1 });
        const second = findMany.mock.calls[1]![0] as { where: Record<string, unknown> };
        expect(second.where.hostname).toEqual({ gt: "a.example.test" });
        expect(second.where.OR).toBeUndefined();
        expect(next).toEqual({
            items: [{ id: "http://b.example.test/", name: "Shop (b.example.test)" }],
            next: null
        });
    });
});
