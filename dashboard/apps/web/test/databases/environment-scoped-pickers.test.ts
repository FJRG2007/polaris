/**
 * The pickers that list other databases and buckets of the same project - the
 * copy sources and the replication targets - name only what sits in the
 * environments the reader can reach. Someone given one environment of a
 * project never sees the names of the others through them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    databaseFindFirst: vi.fn(),
    databaseFindMany: vi.fn(),
    databaseFindUnique: vi.fn(),
    bucketFindFirst: vi.fn(),
    bucketFindMany: vi.fn()
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        managedDatabase: {
            findFirst: mocks.databaseFindFirst,
            findMany: mocks.databaseFindMany,
            findUnique: mocks.databaseFindUnique
        },
        objectBucket: { findFirst: mocks.bucketFindFirst, findMany: mocks.bucketFindMany }
    }
}));
vi.mock("@/lib/deploy/runtime", () => ({ getPorts: vi.fn() }));
vi.mock("@/lib/database-service", () => ({
    databaseCredentials: vi.fn(),
    generateAccessKey: vi.fn(),
    generateSecretKey: vi.fn()
}));

const { copySources } = await import("../../src/lib/database-ops/overview");
const { replicationCandidates } = await import("../../src/lib/object-storage/store");

beforeEach(() => {
    vi.clearAllMocks();
    mocks.databaseFindFirst.mockResolvedValue({
        engine: "postgres",
        environment: { projectId: "project-1" }
    });
    mocks.databaseFindMany.mockResolvedValue([]);
    mocks.databaseFindUnique.mockResolvedValue({
        targetId: "target-1",
        environment: { projectId: "project-1" }
    });
    mocks.bucketFindFirst.mockResolvedValue({ id: "bucket-1", storeId: "store-1" });
    mocks.bucketFindMany.mockResolvedValue([]);
});

describe("copySources", () => {
    it("asks only for the environments the reader holds", async () => {
        await copySources("db-1", "owner-1", ["env-a"]);
        expect(mocks.databaseFindMany.mock.calls[0]![0].where.environmentId).toEqual({
            in: ["env-a"]
        });
    });

    it("leaves an unrestricted reader's list as it was", async () => {
        await copySources("db-1", "owner-1", null);
        expect(mocks.databaseFindMany.mock.calls[0]![0].where).not.toHaveProperty("environmentId");
    });
});

describe("replicationCandidates", () => {
    it("asks only for stores in the environments the reader holds", async () => {
        await replicationCandidates("bucket-1", "owner-1", ["env-a"]);
        expect(mocks.bucketFindMany.mock.calls[0]![0].where.store.environmentId).toEqual({
            in: ["env-a"]
        });
    });

    it("leaves an unrestricted reader's list as it was", async () => {
        await replicationCandidates("bucket-1", "owner-1", null);
        expect(mocks.bucketFindMany.mock.calls[0]![0].where.store).not.toHaveProperty(
            "environmentId"
        );
    });
});
