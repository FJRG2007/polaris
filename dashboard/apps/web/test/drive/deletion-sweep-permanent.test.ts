/**
 * A scheduled deletion runs later, unattended, with the scheduler's rights and
 * whatever path was written down when it was made. That makes it the one delete
 * nobody is watching, so it goes through the same guard as the ones somebody
 * clicks: Polaris's own folder is not deletable on a timer either.
 */

import { StorageError } from "@polaris/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "018f2b7a-0000-7000-8000-0000000000a1";
const ORDINARY = "018f2b7a-0000-7000-8000-0000000000f1";
const RESERVED = "018f2b7a-0000-7000-8000-0000000000f2";

const findMany = vi.fn(async () => [] as unknown[]);
const dropRow = vi.fn(async () => undefined);
const driverDelete = vi.fn(async () => undefined);
const dispose = vi.fn(async () => undefined);
const recordAudit = vi.fn(async () => undefined);

vi.mock("@polaris/db", () => ({
    prisma: {
        scheduledDeletion: {
            findMany,
            delete: dropRow,
            deleteMany: vi.fn(async () => ({ count: 0 })),
            create: vi.fn()
        }
    }
}));
vi.mock("@/lib/storage-service", () => ({
    getDriver: async () => ({ delete: driverDelete, dispose })
}));
vi.mock("@/lib/trash-service", () => ({ moveToTrash: vi.fn(async () => undefined) }));
vi.mock("@/lib/audit-service", () => ({ recordAudit }));
vi.mock("@/lib/drive-folder-size", () => ({ invalidateFolderSizes: vi.fn(async () => undefined) }));

const { sweepDueDeletions } = await import("../../src/lib/scheduled-deletion-service");

/** One due row, permanent, for the given path. */
function due(connectionId: string, path: string) {
    return [{ id: "row-1", ownerId: OWNER, connectionId, path, permanent: true }];
}

beforeEach(() => {
    vi.clearAllMocks();
    driverDelete.mockResolvedValue(undefined);
});

describe("a due permanent deletion", () => {
    it("deletes the path it was scheduled for", async () => {
        findMany.mockResolvedValue(due(ORDINARY, "Invoices/2026"));

        expect(await sweepDueDeletions(ORDINARY)).toBe(1);
        expect(driverDelete).toHaveBeenCalledWith("Invoices/2026", { recursive: true });
        expect(recordAudit).toHaveBeenCalled();
    });

    it("refuses Polaris's own folder and records nothing as deleted", async () => {
        findMany.mockResolvedValue(due(RESERVED, ".polaris"));

        await sweepDueDeletions(RESERVED);

        expect(driverDelete).not.toHaveBeenCalled();
        expect(dispose).toHaveBeenCalled();
        // The row still goes, so a schedule that can never run does not retry forever.
        expect(dropRow).toHaveBeenCalledWith({ where: { id: "row-1" } });
        expect(recordAudit).not.toHaveBeenCalled();
    });

    it("refuses the connection root, which is every file on it", async () => {
        findMany.mockResolvedValue(due(RESERVED, ""));

        await sweepDueDeletions();

        expect(driverDelete).not.toHaveBeenCalled();
        expect(recordAudit).not.toHaveBeenCalled();
    });

    it("still reports an ordinary storage failure as undone", async () => {
        findMany.mockResolvedValue(due(ORDINARY, "Invoices/2026"));
        driverDelete.mockRejectedValue(new StorageError("io_error", "the share went away"));

        await sweepDueDeletions();

        expect(recordAudit).not.toHaveBeenCalled();
    });
});
