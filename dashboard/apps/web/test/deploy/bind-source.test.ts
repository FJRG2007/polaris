/**
 * A server folder is a path under the host's one shared volume root, so which
 * paths a service may name is what keeps one account out of another's data:
 * the agent homes hold people's sign-ins and the archive folders hold whole
 * databases.
 */

import { describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
vi.mock("@polaris/db", () => ({ prisma: { volume: { findFirst } } }));
vi.mock("@/lib/storage-service", () => ({ getDriver: async () => null }));

const { bindSourceAllowed, bindSourceClaimed, isReservedBindSource } = await import(
    "@/lib/deploy-volume-service"
);

describe("bind sources", () => {
    it("refuses the folders Polaris keeps for itself", () => {
        for (const source of [
            "agent-homes",
            "agent-homes/shared",
            "agent-homes/u-someone",
            "pitr",
            "pitr/db-1/wal"
        ]) {
            expect(isReservedBindSource(source)).toBe(true);
            expect(bindSourceAllowed(source, "blog")).toBe(false);
        }
    });

    it("refuses another project's folders and the tree above every project", () => {
        expect(bindSourceAllowed("polaris", "blog")).toBe(false);
        expect(bindSourceAllowed("polaris/deploy", "blog")).toBe(false);
        expect(bindSourceAllowed("polaris/deploy/shop/web/data", "blog")).toBe(false);
        expect(bindSourceAllowed("polaris/deploy/blog-old/web/data", "blog")).toBe(false);
    });

    it("keeps the paths a service ordinarily uses", () => {
        expect(bindSourceAllowed("polaris/deploy/blog", "blog")).toBe(true);
        expect(bindSourceAllowed("polaris/deploy/blog/web/data", "blog")).toBe(true);
        expect(bindSourceAllowed("polaris/deploy/blog/preview/web/data", "blog")).toBe(true);
        expect(bindSourceAllowed("data/uploads", "blog")).toBe(true);
        expect(bindSourceAllowed("agent-homes-backup", "blog")).toBe(true);
    });
});

describe("bind sources other accounts hold", () => {
    it("asks only about other accounts' folders at, inside, or above the path", async () => {
        findFirst.mockResolvedValueOnce({ id: "v2" });
        expect(await bindSourceClaimed("owner-a", null, "polaris/deploy/shop/web/data")).toBe(true);
        const where = findFirst.mock.calls[0]![0].where;
        expect(where.kind).toBe("bind");
        expect(where.target).toEqual({ ownerId: { not: "owner-a" }, hostId: null });
        expect(where.OR).toEqual([
            { source: "polaris/deploy/shop/web/data" },
            { source: { startsWith: "polaris/deploy/shop/web/data/" } },
            {
                source: {
                    in: [
                        "polaris",
                        "polaris/deploy",
                        "polaris/deploy/shop",
                        "polaris/deploy/shop/web"
                    ]
                }
            }
        ]);
    });

    it("lets a folder nobody else holds through, and limits a deploy-time check to earlier claims", async () => {
        findFirst.mockResolvedValueOnce(null);
        const before = new Date("2026-01-01T00:00:00Z");
        expect(await bindSourceClaimed("owner-a", "host-1", "data/uploads", "v1", before)).toBe(
            false
        );
        const where = findFirst.mock.calls.at(-1)![0].where;
        expect(where.id).toEqual({ not: "v1" });
        expect(where.createdAt).toEqual({ lt: before });
        expect(where.target).toEqual({ ownerId: { not: "owner-a" }, hostId: "host-1" });
        expect(where.OR[2]).toEqual({ source: { in: ["data"] } });
    });
});
