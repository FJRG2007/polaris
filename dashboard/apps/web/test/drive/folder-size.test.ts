/**
 * Folder weights. A wrong number here is worse than no number, so what is pinned
 * is the arithmetic (a folder weighs everything under it, once), the reuse of a
 * fresh measurement instead of walking the same subtree again, the refusal to
 * report a total that was cut short, and the invalidation reaching both the
 * subtree that changed and every ancestor whose total changed with it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageDriver } from "@polaris/storage";

const findMany = vi.fn();
const deleteMany = vi.fn();
const upsert = vi.fn((args: unknown) => args);
const transaction = vi.fn(async () => []);

vi.mock("@polaris/db", () => ({
    prisma: {
        driveFolderSize: { findMany, deleteMany, upsert },
        $transaction: transaction
    }
}));

const { createSizeBudget, invalidateFolderSizes, measureFolder, FOLDER_SIZE_TTL_MS } = await import(
    "../../src/lib/drive-folder-size"
);

const CONNECTION = "018f2b7a-0000-7000-8000-000000000001";

interface FakeEntry {
    name: string;
    kind: "file" | "dir";
    size?: number;
}

/** A driver that lists a fixed tree, counting the folders it was asked for. */
function fakeDriver(tree: Record<string, FakeEntry[]>) {
    const listed: string[] = [];
    const driver = {
        async list(path: string) {
            listed.push(path);
            const entries = tree[path];
            if (!entries) throw new Error(`no such folder: ${path}`);
            return {
                entries: entries.map((entry) => ({
                    name: entry.name,
                    path: path ? `${path}/${entry.name}` : entry.name,
                    kind: entry.kind,
                    size: BigInt(entry.size ?? 0),
                    modifiedAt: new Date("2026-01-01T00:00:00.000Z")
                }))
            };
        }
    } as unknown as StorageDriver;
    return { driver, listed };
}

const TREE: Record<string, FakeEntry[]> = {
    docs: [
        { name: "a.txt", kind: "file", size: 100 },
        { name: "sub", kind: "dir" },
        { name: "gated", kind: "dir" }
    ],
    "docs/sub": [
        { name: "b.bin", kind: "file", size: 250 },
        { name: "deep", kind: "dir" }
    ],
    "docs/sub/deep": [{ name: "c.bin", kind: "file", size: 1000 }],
    "docs/gated": [{ name: "private.txt", kind: "file", size: 9999 }]
};

beforeEach(() => {
    findMany.mockReset();
    findMany.mockResolvedValue([]);
    deleteMany.mockReset();
    deleteMany.mockResolvedValue({ count: 0 });
    upsert.mockClear();
    transaction.mockClear();
});

/** The measured size, failing the test when the walk did not finish. */
function measured(outcome: Awaited<ReturnType<typeof measureFolder>>) {
    expect(outcome.status).toBe("measured");
    if (outcome.status !== "measured") throw new Error("not measured");
    return outcome.size;
}

describe("measureFolder", () => {
    it("adds up every file under the folder, once", async () => {
        const { driver } = fakeDriver(TREE);
        const size = measured(
            await measureFolder(driver, CONNECTION, "docs", {
                budget: createSizeBudget(5000),
                skip: new Set(["docs/gated"])
            })
        );
        expect(size.bytes).toBe(1350n);
        expect(size.files).toBe(3);
        expect(size.folders).toBe(3);
    });

    it("counts a gated folder without opening it, and says the total is a floor", async () => {
        const { driver, listed } = fakeDriver(TREE);
        const size = measured(
            await measureFolder(driver, CONNECTION, "docs", {
                budget: createSizeBudget(5000),
                skip: new Set(["docs/gated"])
            })
        );
        expect(listed).not.toContain("docs/gated");
        expect(size.partial).toBe(true);
    });

    it("reuses a fresh measurement instead of walking that subtree again", async () => {
        findMany.mockResolvedValue([
            {
                path: "docs/sub",
                bytes: 1250n,
                files: 2,
                folders: 1,
                partial: false,
                computedAt: new Date()
            }
        ]);
        const { driver, listed } = fakeDriver(TREE);
        const size = measured(
            await measureFolder(driver, CONNECTION, "docs", {
                budget: createSizeBudget(5000),
                skip: new Set(["docs/gated"])
            })
        );
        expect(listed).toEqual(["docs"]);
        expect(size.bytes).toBe(1350n);
    });

    it("walks a subtree again once its measurement has aged out", async () => {
        findMany.mockResolvedValue([
            {
                path: "docs/sub",
                bytes: 1n,
                files: 1,
                folders: 0,
                partial: false,
                computedAt: new Date(Date.now() - FOLDER_SIZE_TTL_MS - 1000)
            }
        ]);
        const { driver, listed } = fakeDriver(TREE);
        const size = measured(
            await measureFolder(driver, CONNECTION, "docs", {
                budget: createSizeBudget(5000),
                skip: new Set(["docs/gated"])
            })
        );
        expect(listed).toContain("docs/sub");
        expect(size.bytes).toBe(1350n);
    });

    it("defers rather than reporting a total cut short by the budget", async () => {
        const { driver } = fakeDriver(TREE);
        const outcome = await measureFolder(driver, CONNECTION, "docs", {
            // Only the top folder can be listed; the rest is out of budget.
            budget: createSizeBudget(5000, 1),
            skip: new Set(["docs/gated"])
        });
        expect(outcome.status).toBe("deferred");
    });

    it("keeps the sub-folders it did finish, so the next attempt starts from them", async () => {
        const { driver } = fakeDriver({
            docs: [
                { name: "one", kind: "dir" },
                { name: "two", kind: "dir" }
            ],
            "docs/one": [{ name: "a.bin", kind: "file", size: 10 }],
            "docs/two": [{ name: "b.bin", kind: "file", size: 20 }]
        });
        // Enough to list "docs" and finish "one", not enough to reach "two".
        const outcome = await measureFolder(driver, CONNECTION, "docs", {
            budget: createSizeBudget(5000, 2)
        });
        expect(outcome.status).toBe("deferred");
        const stored = upsert.mock.calls.map(
            ([args]) =>
                (args as { where: { connectionId_path: { path: string } } }).where.connectionId_path
                    .path
        );
        expect(stored).toEqual(["docs/one"]);
    });

    it("says a folder it cannot list is unreadable, so it is not asked about again", async () => {
        const { driver } = fakeDriver({});
        const outcome = await measureFolder(driver, CONNECTION, "docs", {
            budget: createSizeBudget(5000)
        });
        expect(outcome.status).toBe("unreadable");
    });

    it("still measures a folder holding one it cannot read, as a floor", async () => {
        const { driver } = fakeDriver({
            docs: [
                { name: "a.bin", kind: "file", size: 40 },
                { name: "denied", kind: "dir" }
            ]
        });
        const size = measured(
            await measureFolder(driver, CONNECTION, "docs", { budget: createSizeBudget(5000) })
        );
        expect(size.bytes).toBe(40n);
        expect(size.partial).toBe(true);
    });
});

describe("invalidateFolderSizes", () => {
    it("forgets the path, its subtree and every ancestor", async () => {
        await invalidateFolderSizes(CONNECTION, "docs/sub/deep");
        const where = deleteMany.mock.calls[0]?.[0]?.where as {
            connectionId: string;
            OR: Array<Record<string, unknown>>;
        };
        expect(where.connectionId).toBe(CONNECTION);
        expect(where.OR[0]).toEqual({ path: { in: ["", "docs", "docs/sub", "docs/sub/deep"] } });
        expect(where.OR[1]).toEqual({ path: { startsWith: "docs/sub/deep/" } });
    });

    it("clears the root measurement when a root-level item changes", async () => {
        await invalidateFolderSizes(CONNECTION, "report.pdf");
        const where = deleteMany.mock.calls[0]?.[0]?.where as {
            OR: Array<Record<string, unknown>>;
        };
        expect(where.OR[0]).toEqual({ path: { in: ["", "report.pdf"] } });
    });

    it("does nothing for a source that is not a stored connection", async () => {
        await invalidateFolderSizes("container:app-1", "docs");
        expect(deleteMany).not.toHaveBeenCalled();
    });
});
