/**
 * The long jobs Drive runs after the tab has gone.
 *
 * The defect these exist for is one shape: a loop in the browser that opened a
 * connection to the storage per file. So the thing worth pinning is that a batch
 * is ONE call into the bulk operation rather than one per path, that what got
 * done is written down between batches - which is what makes an interrupted job
 * resume rather than restart - and that a job somebody stopped stops.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface JobRow {
    id: string;
    ownerId: string;
    connectionId: string;
    kind: string;
    label: string;
    pending: string;
    total: number;
    done: number;
    failed: number;
    error: string | null;
    state: string;
    leaseUntil: Date | null;
    startedAt: Date | null;
    finishedAt: Date | null;
}

let row: JobRow;

/** Every call into the bulk trash, so "one session per batch" can be asserted
 *  rather than assumed. */
const moveManyToTrash = vi.fn(async (_owner: string, _connection: string, paths: readonly string[]) => ({
    moved: [...paths],
    failures: [] as { path: string; reason: string }[]
}));

const deleteDriveEntry = vi.fn(async () => undefined);
const disposed = vi.fn(async () => undefined);
const getDriver = vi.fn(async () => ({ dispose: disposed }));

vi.mock("@polaris/db", () => ({
    prisma: {
        driveJob: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
                row = { ...row, ...(data as unknown as JobRow), id: "j1" };
                return { id: "j1" };
            },
            findUnique: async () => ({ ...row }),
            findMany: async () => [{ id: row.id }],
            update: async ({ data }: { data: Record<string, unknown> }) => {
                Object.assign(row, data);
                return { ...row };
            },
            updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
                // The take: only a queued job, or one whose worker has gone quiet.
                const wanted = where.state as string | undefined;
                if (wanted !== undefined && row.state !== wanted) return { count: 0 };
                if (where.OR && row.state !== "queued" && row.leaseUntil && row.leaseUntil > new Date()) {
                    return { count: 0 };
                }
                Object.assign(row, data);
                return { count: 1 };
            },
            deleteMany: async () => ({ count: 0 })
        }
    }
}));

vi.mock("@/lib/trash-service", () => ({ moveManyToTrash, restoreTrash: vi.fn() }));
vi.mock("@/lib/drive-delete", () => ({ deleteDriveEntry }));
vi.mock("@/lib/storage-service", () => ({ getDriver }));

const jobs = await import("../../src/lib/drive-jobs");

function seed(paths: string[], kind = "trash"): void {
    row = {
        id: "j1",
        ownerId: "u1",
        connectionId: "c1",
        kind,
        label: "Moving things",
        pending: JSON.stringify(paths),
        total: paths.length,
        done: 0,
        failed: 0,
        error: null,
        state: "queued",
        leaseUntil: null,
        startedAt: null,
        finishedAt: null
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    seed([]);
});

describe("working a job", () => {
    it("hands a whole batch to one call, not one call per path", async () => {
        // The entire point: the connection to the storage is opened once for the
        // batch. A loop of single calls is what made binning seven thousand files
        // seven thousand handshakes.
        seed(Array.from({ length: 40 }, (_, index) => `folder/file-${index}.txt`));
        await jobs.workDriveJob("j1");

        expect(moveManyToTrash).toHaveBeenCalledTimes(1);
        expect(moveManyToTrash.mock.calls[0]?.[2]).toHaveLength(40);
        expect(row.done).toBe(40);
        expect(row.state).toBe("finished");
    });

    it("takes more than one batch when there is more than one batch of work", async () => {
        seed(Array.from({ length: 250 }, (_, index) => `f${index}`));
        await jobs.workDriveJob("j1");

        // 100 a time, so three passes - and three sessions rather than 250.
        expect(moveManyToTrash).toHaveBeenCalledTimes(3);
        expect(row.done).toBe(250);
    });

    it("writes down where it got to between batches", async () => {
        seed(Array.from({ length: 250 }, (_, index) => `f${index}`));
        const seen: number[] = [];
        moveManyToTrash.mockImplementation(async (_owner, _connection, paths) => {
            seen.push(JSON.parse(row.pending).length);
            return { moved: [...paths], failures: [] };
        });

        await jobs.workDriveJob("j1");
        // What was left before each pass: an interrupted job resumes from these
        // rather than starting again on files it has already moved.
        expect(seen).toEqual([250, 150, 50]);
    });

    it("keeps going past a path that will not move, and remembers why", async () => {
        seed(["a", "b", "c"]);
        moveManyToTrash.mockResolvedValue({
            moved: ["a", "c"],
            failures: [{ path: "b", reason: "Permission denied" }]
        });

        await jobs.workDriveJob("j1");
        expect(row.done).toBe(2);
        expect(row.failed).toBe(1);
        expect(row.error).toBe("Permission denied");
        // One file that will not move is not a reason to leave the rest where
        // they are.
        expect(row.state).toBe("finished");
    });

    it("counts a whole unreachable share as failures rather than throwing", async () => {
        seed(["a", "b"]);
        moveManyToTrash.mockRejectedValue(new Error("Share is not mounted"));

        await expect(jobs.workDriveJob("j1")).resolves.toBeUndefined();
        expect(row.failed).toBe(2);
        expect(row.error).toBe("Share is not mounted");
    });

    it("does nothing to a job another worker holds", async () => {
        seed(["a"]);
        row.state = "running";
        row.leaseUntil = new Date(Date.now() + 60_000);

        await jobs.workDriveJob("j1");
        expect(moveManyToTrash).not.toHaveBeenCalled();
    });

    it("stops between batches when somebody stopped it", async () => {
        seed(Array.from({ length: 250 }, (_, index) => `f${index}`));
        moveManyToTrash.mockImplementation(async (_owner, _connection, paths) => {
            row.state = "cancelled";
            return { moved: [...paths], failures: [] };
        });

        await jobs.workDriveJob("j1");
        // The first batch is already gone - this is "stop", not "undo".
        expect(moveManyToTrash).toHaveBeenCalledTimes(1);
        expect(row.state).toBe("cancelled");
    });
});

describe("deleting permanently", () => {
    it("opens one driver for the batch and lets go of it", async () => {
        seed(["a", "b", "c"], "delete");
        await jobs.workDriveJob("j1");

        expect(getDriver).toHaveBeenCalledTimes(1);
        expect(deleteDriveEntry).toHaveBeenCalledTimes(3);
        // The trap this whole module exists to avoid is a session left open.
        expect(disposed).toHaveBeenCalledTimes(1);
    });
});
