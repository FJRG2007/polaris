/**
 * Taking a storage connection out.
 *
 * Two rules carry the whole feature. A device something still mounts cannot just
 * be forgotten - the service would come back up to an empty data directory, and
 * finding that out later is the expensive way. And a move is a copy first: the
 * volumes are only repointed once every byte is on the far side under the same
 * path, so a copy that fails leaves the old connection intact and still serving.
 */

import type { StorageDriver } from "@polaris/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "018f2b7a-0000-7000-8000-0000000000a1";
const SOURCE = "018f2b7a-0000-7000-8000-0000000000e1";
const DESTINATION = "018f2b7a-0000-7000-8000-0000000000e2";
const APP = "018f2b7a-0000-7000-8000-0000000000d1";

const connectionFindFirst = vi.fn();
const connectionFindMany = vi.fn(async () => []);
const volumeFindMany = vi.fn(async () => []);
const volumeUpdateMany = vi.fn(async (args: unknown) => args);
const shareCount = vi.fn(async () => 0);
const fileRequestCount = vi.fn(async () => 0);
const deleteConnection = vi.fn(async () => undefined);
const deployAndWait = vi.fn(async () => null as string | null);
const getDriver = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        storageConnection: { findFirst: connectionFindFirst, findMany: connectionFindMany },
        volume: { findMany: volumeFindMany, updateMany: volumeUpdateMany },
        share: { count: shareCount },
        fileRequest: { count: fileRequestCount }
    }
}));
vi.mock("@/lib/storage-service", () => ({ deleteConnection, getDriver }));
vi.mock("@/lib/deploy-service", () => ({ deployAndWait }));

const { getConnectionRemovalPlan, removeConnection } = await import("../../src/lib/connection-removal-service");

/** A two-level tree, and a destination that records what it was given. */
function drivers() {
    const tree: Record<string, { name: string; path: string; kind: "dir" | "file"; size: bigint }[]> = {
        "": [
            { name: "photos", path: "photos", kind: "dir", size: 0n },
            { name: "notes.txt", path: "notes.txt", kind: "file", size: 12n }
        ],
        photos: [{ name: "a.jpg", path: "photos/a.jpg", kind: "file", size: 90n }]
    };
    const written: string[] = [];
    const made: string[] = [];
    const from = {
        list: async (path: string) => ({ entries: tree[path] ?? [] }),
        readStream: async (path: string) => path,
        dispose: async () => undefined
    } as unknown as StorageDriver;
    const to = {
        mkdir: async (path: string) => {
            made.push(path);
        },
        writeStream: async (path: string) => {
            written.push(path);
            return {};
        },
        dispose: async () => undefined
    } as unknown as StorageDriver;
    return { from, to, written, made };
}

/** One service mounting a folder on the connection being removed. */
function oneMountedService() {
    volumeFindMany.mockResolvedValue([{ name: "data", application: { id: APP, name: "postgres" } }]);
}

describe("removing a storage connection", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        connectionFindFirst.mockImplementation(async (args: { where: { id: string } }) =>
            args.where.id === SOURCE
                ? { id: SOURCE, name: "unas" }
                : args.where.id === DESTINATION
                  ? { id: DESTINATION, name: "backup" }
                  : null
        );
        volumeFindMany.mockResolvedValue([]);
        deployAndWait.mockResolvedValue(null);
    });

    it("forgets a connection nothing depends on", async () => {
        const result = await removeConnection(OWNER, SOURCE, OWNER, { mode: "forget" });
        expect(result.error).toBeUndefined();
        expect(deleteConnection).toHaveBeenCalledWith(OWNER, SOURCE);
    });

    it("refuses to forget a connection a service still mounts", async () => {
        oneMountedService();
        const result = await removeConnection(OWNER, SOURCE, OWNER, { mode: "forget" });
        expect(result.error).toContain("postgres");
        expect(deleteConnection).not.toHaveBeenCalled();
    });

    it("copies every file under the same path, then repoints and redeploys", async () => {
        oneMountedService();
        const fake = drivers();
        getDriver.mockImplementation(async (id: string) => (id === SOURCE ? fake.from : fake.to));

        const result = await removeConnection(OWNER, SOURCE, OWNER, {
            mode: "move",
            destinationId: DESTINATION
        });

        expect(result.error).toBeUndefined();
        // Paths are identical on the far side - that is what lets a volume simply
        // change which device it points at.
        expect(fake.made).toEqual(["photos"]);
        expect([...fake.written].sort()).toEqual(["notes.txt", "photos/a.jpg"]);
        expect(volumeUpdateMany).toHaveBeenCalledWith({
            where: { connectionId: SOURCE },
            data: { connectionId: DESTINATION }
        });
        expect(result.redeployed).toEqual(["postgres"]);
        expect(deleteConnection).toHaveBeenCalledWith(OWNER, SOURCE);
    });

    it("keeps the connection when the copy fails", async () => {
        oneMountedService();
        getDriver.mockImplementation(async () => {
            throw new Error("the device is not answering");
        });

        const result = await removeConnection(OWNER, SOURCE, OWNER, {
            mode: "move",
            destinationId: DESTINATION
        });

        expect(result.error).toContain("not answering");
        expect(volumeUpdateMany).not.toHaveBeenCalled();
        expect(deleteConnection).not.toHaveBeenCalled();
    });

    it("says which service did not come back, without putting the data back", async () => {
        oneMountedService();
        const fake = drivers();
        getDriver.mockImplementation(async (id: string) => (id === SOURCE ? fake.from : fake.to));
        deployAndWait.mockResolvedValue("no such image");

        const result = await removeConnection(OWNER, SOURCE, OWNER, {
            mode: "move",
            destinationId: DESTINATION
        });

        expect(result.warnings?.[0]).toContain("postgres");
        expect(result.redeployed).toEqual([]);
        // The copy is good and the volumes point at it; the service is what needs
        // fixing, so the removal still finishes rather than half-unwinding.
        expect(deleteConnection).toHaveBeenCalled();
    });

    it("reports what depends on it before anything is destroyed", async () => {
        oneMountedService();
        shareCount.mockResolvedValue(3);
        fileRequestCount.mockResolvedValue(1);
        connectionFindMany.mockResolvedValue([{ id: DESTINATION, name: "backup" }]);

        const plan = await getConnectionRemovalPlan(OWNER, SOURCE);

        expect(plan?.services).toEqual([{ id: APP, name: "postgres", volume: "data" }]);
        expect(plan?.shares).toBe(3);
        expect(plan?.fileRequests).toBe(1);
        expect(plan?.destinations).toEqual([{ id: DESTINATION, name: "backup" }]);
    });
});
