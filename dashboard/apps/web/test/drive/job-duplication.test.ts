/**
 * The same deletion, started twice.
 *
 * A job takes minutes, and everything it has not reached yet is still in the
 * listing. So somebody deletes three thousand files, reloads, sees most of them
 * still there and deletes them again - and the second job races the first over
 * every file: it finds them gone, records failures nobody caused, and reports
 * that part of the deletion did not work.
 *
 * The screen is one half of the answer and this is the other. A browser can be
 * reloaded, a second tab can be opened, and somebody else can be looking at the
 * same shared folder - none of which the screen controls. So the refusal is
 * here, on the connection rather than on the account, because the connection is
 * what two people share.
 *
 * What it must not do is refuse everything. A selection that overlaps a running
 * job by one file is still a selection of two thousand files somebody meant to
 * delete.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CONNECTION = "11111111-1111-4111-8111-111111111111";
const ADA = "22222222-2222-4222-8222-222222222222";
const GRACE = "33333333-3333-4333-8333-333333333333";

/** Jobs the database is holding, live ones included. */
let jobs: { connectionId: string; state: string; pending: string }[] = [];
const created = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        driveJob: {
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                jobs.filter(
                    (job) =>
                        job.connectionId === where.connectionId &&
                        (where.state as { in: string[] }).in.includes(job.state)
                ),
            create: async (args: { data: Record<string, unknown> }) => {
                created(args.data);
                return { id: "job-2" };
            },
            updateMany: async () => ({ count: 0 }),
            findUnique: async () => null
        }
    }
}));

const { pathsInFlight, startDriveJob, AlreadyGoingError } = await import(
    "../../src/lib/drive-jobs"
);

function start(paths: string[], ownerId = ADA) {
    return startDriveJob({
        ownerId,
        connectionId: CONNECTION,
        kind: "trash",
        label: `Moving ${paths.length} items`,
        paths
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    jobs = [];
});

describe("what is already on its way out", () => {
    it("is nothing when no job is running", async () => {
        expect((await pathsInFlight(CONNECTION)).size).toBe(0);
    });

    it("is what live jobs still have left, whoever started them", async () => {
        jobs = [
            { connectionId: CONNECTION, state: "running", pending: JSON.stringify(["a.txt"]) },
            { connectionId: CONNECTION, state: "queued", pending: JSON.stringify(["b.txt"]) },
            // Finished, so its files are gone rather than going.
            { connectionId: CONNECTION, state: "finished", pending: JSON.stringify(["c.txt"]) }
        ];
        expect([...(await pathsInFlight(CONNECTION))].sort()).toEqual(["a.txt", "b.txt"]);
    });

    it("survives a pending list that is not a list", async () => {
        // It is JSON in a column, read back later - not a value this process
        // wrote a moment ago.
        jobs = [{ connectionId: CONNECTION, state: "running", pending: "{oh dear" }];
        expect((await pathsInFlight(CONNECTION)).size).toBe(0);
    });
});

describe("starting a job over one already running", () => {
    beforeEach(() => {
        jobs = [
            {
                connectionId: CONNECTION,
                state: "running",
                pending: JSON.stringify(["a.txt", "b.txt"])
            }
        ];
    });

    it("refuses when every path is already going", async () => {
        await expect(start(["a.txt", "b.txt"])).rejects.toBeInstanceOf(AlreadyGoingError);
        expect(created).not.toHaveBeenCalled();
    });

    it("refuses it for somebody else's job too", async () => {
        // Two people looking at the same shared folder are two people who can
        // press delete on the same rows, and neither has done anything wrong.
        await expect(start(["a.txt"], GRACE)).rejects.toBeInstanceOf(AlreadyGoingError);
    });

    it("takes the rest of a selection that only overlaps", async () => {
        await start(["a.txt", "c.txt", "d.txt"]);
        expect(created).toHaveBeenCalledWith(
            expect.objectContaining({ pending: JSON.stringify(["c.txt", "d.txt"]), total: 2 })
        );
    });

    it("leaves a job on another connection alone", async () => {
        jobs = [
            {
                connectionId: "44444444-4444-4444-8444-444444444444",
                state: "running",
                pending: JSON.stringify(["a.txt"])
            }
        ];
        await start(["a.txt"]);
        expect(created).toHaveBeenCalledWith(expect.objectContaining({ total: 1 }));
    });
});

describe("a job with nothing in it", () => {
    it("is refused rather than queued", async () => {
        await expect(start([])).rejects.toBeInstanceOf(AlreadyGoingError);
    });
});
