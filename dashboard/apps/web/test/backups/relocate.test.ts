/**
 * Moving copies between destinations, and choosing the default.
 *
 * Copies start on the data dir, which shares a disk with what it protects. The
 * move that takes them to a NAS must never leave a point with no copy at all: the
 * new one is written and marked available before the old one is removed, and a
 * copy that fails to arrive whole leaves the old one exactly where it was.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface CopyRow {
    id: string;
    pointId: string;
    destinationId: string;
    path: string;
    sizeBytes: bigint;
    status: string;
    sealedWith: string | null;
    error?: string | null;
}

interface JobRow {
    id: string;
    ownerId: string;
    type: string;
    status: string;
    resourceId: string | null;
    error?: string | null;
}

const state = vi.hoisted(() => ({
    copies: [] as CopyRow[],
    destinations: [] as {
        id: string;
        ownerId: string;
        name: string;
        kind: string;
        isDefault: boolean;
    }[],
    jobs: [] as JobRow[],
    handles: new Map<string, DestinationHandle>(),
    queries: [] as unknown[],
    next: 0
}));

vi.mock("@/lib/backups/destination", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/backups/destination")>()),
    openDestination: async (row: { id: string }) => {
        const handle = state.handles.get(row.id);
        if (!handle) throw new Error("no handle");
        return handle;
    }
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        recoveryPointCopy: {
            findUnique: async ({
                where
            }: {
                where: { pointId_destinationId: { pointId: string; destinationId: string } };
            }) =>
                state.copies.find(
                    (copy) =>
                        copy.pointId === where.pointId_destinationId.pointId &&
                        copy.destinationId === where.pointId_destinationId.destinationId
                ) ?? null,
            create: async ({ data }: { data: Omit<CopyRow, "id"> }) => {
                const row = { id: `new-${state.next++}`, ...data };
                state.copies.push(row);
                return row;
            },
            update: async ({ where, data }: { where: { id: string }; data: Partial<CopyRow> }) => {
                const row = state.copies.find((copy) => copy.id === where.id);
                if (!row) throw new Error("no row");
                Object.assign(row, data);
                return row;
            },
            delete: async ({ where }: { where: { id: string } }) => {
                state.copies = state.copies.filter((copy) => copy.id !== where.id);
            },
            count: async ({ where }: { where: { destinationId: string; status: string } }) =>
                state.copies.filter(
                    (copy) =>
                        copy.destinationId === where.destinationId && copy.status === where.status
                ).length,
            findMany: async (query: {
                where: { destinationId: string; status: string; id?: { gt: string } };
                take: number;
            }) => {
                state.queries.push(query.where);
                const after = query.where.id?.gt;
                return state.copies
                    .filter(
                        (copy) =>
                            copy.destinationId === query.where.destinationId &&
                            copy.status === query.where.status &&
                            (after === undefined || copy.id > after)
                    )
                    .sort((a, b) => (a.id < b.id ? -1 : 1))
                    .slice(0, query.take);
            }
        },
        backupJob: {
            updateMany: async ({
                where,
                data
            }: {
                where: Partial<JobRow>;
                data: Partial<JobRow>;
            }) => {
                for (const job of state.jobs) {
                    if (
                        job.type === where.type &&
                        job.status === where.status &&
                        job.resourceId === where.resourceId
                    ) {
                        Object.assign(job, data);
                    }
                }
            },
            create: async ({ data }: { data: { ownerId: string; type: string } }) => {
                const job = {
                    id: `job-${state.next++}`,
                    status: "running",
                    resourceId: null,
                    ...data
                };
                state.jobs.push(job);
                return job;
            },
            update: async ({ where, data }: { where: { id: string }; data: Partial<JobRow> }) => {
                const job = state.jobs.find((one) => one.id === where.id);
                if (job) Object.assign(job, data);
                return job;
            }
        },
        backupDestination: {
            findFirst: async ({ where }: { where: { id: string; ownerId: string } }) =>
                state.destinations.find(
                    (row) => row.id === where.id && row.ownerId === where.ownerId
                ) ?? null,
            updateMany: ({
                where,
                data
            }: {
                where: { ownerId: string; id: { not: string } };
                data: { isDefault: boolean };
            }) => ({
                run: () => {
                    for (const row of state.destinations) {
                        if (row.ownerId === where.ownerId && row.id !== where.id.not)
                            row.isDefault = data.isDefault;
                    }
                }
            }),
            update: ({ where, data }: { where: { id: string }; data: { isDefault: boolean } }) => ({
                run: () => {
                    const row = state.destinations.find((one) => one.id === where.id);
                    if (row) row.isDefault = data.isDefault;
                }
            })
        },
        $transaction: async (steps: { run: () => void }[]) => {
            for (const step of steps) step.run();
        }
    }
}));

import type { DestinationHandle } from "@/lib/backups/destination";
import {
    isMoving,
    moveOneCopy,
    setDefaultDestination,
    startMovingCopies
} from "@/lib/backups/relocate";

function store(files: Map<string, number>, failPut = false, shortBy = 0): DestinationHandle {
    return {
        put: async (path, _body, size) => {
            if (failPut) throw new Error("The share refused the write");
            files.set(path, Number(size) - shortBy);
            return { sizeBytes: Number(size) - shortBy };
        },
        get: async () => new ReadableStream<Uint8Array>(),
        remove: async (path) => {
            files.delete(path);
        },
        usage: async () => ({}),
        dispose: async () => undefined
    };
}

const copy = (): CopyRow => ({
    id: "old-1",
    pointId: "point-1",
    destinationId: "local",
    path: "res-1/world.tar.zst.sealed",
    sizeBytes: 500n,
    status: "available",
    sealedWith: "key-1"
});

beforeEach(() => {
    state.copies = [copy()];
    state.jobs = [];
    state.handles = new Map();
    state.queries = [];
    state.next = 0;
    state.destinations = [
        { id: "local", ownerId: "me", name: "Polaris data dir", kind: "local", isDefault: true },
        { id: "nas", ownerId: "me", name: "UNAS", kind: "connection", isDefault: false },
        {
            id: "beside",
            ownerId: "me",
            name: "Beside the source",
            kind: "source-local",
            isDefault: false
        }
    ];
});

describe("moving one copy", () => {
    it("writes it to the new destination, keeps its seal, and only then removes the old one", async () => {
        const local = new Map([["res-1/world.tar.zst.sealed", 500]]);
        const nas = new Map<string, number>();
        const moved = await moveOneCopy(copy(), store(local), store(nas), "nas");
        expect(moved).toBe(500);
        expect(nas.get("res-1/world.tar.zst.sealed")).toBe(500);
        expect(local.size).toBe(0);
        expect(state.copies).toEqual([
            expect.objectContaining({
                destinationId: "nas",
                status: "available",
                sealedWith: "key-1",
                sizeBytes: 500n
            })
        ]);
    });

    it("leaves the old copy where it was when the new one cannot be written", async () => {
        const local = new Map([["res-1/world.tar.zst.sealed", 500]]);
        await expect(
            moveOneCopy(copy(), store(local), store(new Map(), true), "nas")
        ).rejects.toThrow();
        expect(local.size).toBe(1);
        expect(state.copies.find((row) => row.id === "old-1")?.status).toBe("available");
        expect(state.copies.find((row) => row.destinationId === "nas")).toBeUndefined();
    });

    it("leaves the old copy when the new one arrives a different size", async () => {
        const local = new Map([["res-1/world.tar.zst.sealed", 500]]);
        const nas = new Map<string, number>();
        await expect(
            moveOneCopy(copy(), store(local), store(nas, false, 10), "nas")
        ).rejects.toThrow();
        expect(local.size).toBe(1);
        expect(nas.size).toBe(0);
        expect(state.copies.find((row) => row.id === "old-1")).toBeDefined();
        expect(state.copies.find((row) => row.destinationId === "nas")).toBeUndefined();
    });

    it("only removes the old copy when the new destination already holds that point", async () => {
        state.copies.push({ ...copy(), id: "there", destinationId: "nas" });
        const local = new Map([["res-1/world.tar.zst.sealed", 500]]);
        const nas = new Map<string, number>();
        await moveOneCopy(copy(), store(local), store(nas), "nas");
        expect(nas.size).toBe(0);
        expect(local.size).toBe(0);
        expect(state.copies.map((row) => row.id)).toEqual(["there"]);
    });
});

describe("the default destination", () => {
    it("is one per owner", async () => {
        await setDefaultDestination("me", "nas");
        expect(state.destinations.filter((row) => row.isDefault).map((row) => row.id)).toEqual([
            "nas"
        ]);
    });

    it("is never copies beside the source, which most kinds cannot keep", async () => {
        await expect(setDefaultDestination("me", "beside")).rejects.toThrow(
            /cannot be the default/
        );
        expect(state.destinations.find((row) => row.isDefault)?.id).toBe("local");
    });

    it("is never somebody else's destination", async () => {
        await expect(setDefaultDestination("someone-else", "nas")).rejects.toThrow(
            /does not exist/
        );
    });
});

describe("starting a move", () => {
    it("refuses the same destination, and copies beside the source", async () => {
        await expect(
            startMovingCopies({ ownerId: "me", fromId: "local", toId: "local", actorId: "me" })
        ).rejects.toThrow(/different destination/);
        await expect(
            startMovingCopies({ ownerId: "me", fromId: "local", toId: "beside", actorId: "me" })
        ).rejects.toThrow(/cannot be moved/);
    });
});

async function settled(fromId: string): Promise<void> {
    await vi.waitFor(() => expect(isMoving(fromId)).toBe(false));
}

describe("a running move", () => {
    it("stops once the target refuses copies in a row, and leaves nothing on it", async () => {
        state.copies = Array.from({ length: 6 }, (_, index) => ({
            ...copy(),
            id: `old-${index}`,
            pointId: `point-${index}`,
            path: `p-${index}`
        }));
        state.handles.set("local", store(new Map()));
        state.handles.set("nas", store(new Map(), true));
        await startMovingCopies({ ownerId: "me", fromId: "local", toId: "nas", actorId: "me" });
        await settled("local");
        expect(state.copies.filter((row) => row.destinationId === "local")).toHaveLength(6);
        expect(state.copies.filter((row) => row.destinationId === "nas")).toHaveLength(0);
        expect(state.jobs[0]).toEqual(expect.objectContaining({ status: "failed" }));
        expect(state.queries).toHaveLength(1);
    });

    it("never marks a move still running here as lost", async () => {
        state.destinations.push({
            id: "other",
            ownerId: "me",
            name: "Other",
            kind: "local",
            isDefault: false
        });
        state.copies.push({ ...copy(), id: "old-2", pointId: "point-2", destinationId: "other" });
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const slow: DestinationHandle = {
            ...store(new Map()),
            put: async (_path, _body, size) => {
                await held;
                return { sizeBytes: Number(size) };
            }
        };
        state.handles.set("local", store(new Map()));
        state.handles.set("other", store(new Map()));
        state.handles.set("nas", slow);
        await startMovingCopies({ ownerId: "me", fromId: "local", toId: "nas", actorId: "me" });
        await startMovingCopies({ ownerId: "me", fromId: "other", toId: "nas", actorId: "me" });
        expect(state.jobs.map((job) => job.status)).toEqual(["running", "running"]);
        release();
        await settled("local");
        await settled("other");
        expect(state.jobs.map((job) => job.status)).toEqual(["succeeded", "succeeded"]);
    });
});
