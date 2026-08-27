/**
 * A personal drive is not a disk the instance may use.
 *
 * It is a StorageConnection row, which is what makes every Drive feature work on
 * it for free - and is exactly what makes this dangerous: every screen that says
 * "pick a storage" reads that table. Left alone, an administrator would be
 * offered somebody's private drive as the place to put profile photos, chat
 * attachments, a backup or a deployed service's data directory.
 *
 * So each of those lists has to leave it out, and the query is the only place
 * that can be checked without a database. What is asserted here is that the
 * filter is actually in the `where` - a list that quietly loses it would look
 * fine on an instance where nobody has opened Drive yet.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "018f2b7a-0000-7000-8000-0000000000a1";

const findMany = vi.fn(async () => []);
const findUnique = vi.fn(async () => null);
const getSetting = vi.fn(async () => null);

vi.mock("@polaris/db", () => ({
    prisma: { storageConnection: { findMany, findUnique } }
}));
vi.mock("@/lib/setting-store", () => ({ getSetting, setSetting: vi.fn() }));
vi.mock("@/lib/storage-service", () => ({ getDriverForConnection: vi.fn() }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_DATA_DIR: "/data" }) }));

const { resolveTargetChoice, storageTargetOptions } = await import("../../src/lib/storage-target");

beforeEach(() => {
    vi.clearAllMocks();
    findMany.mockResolvedValue([]);
    findUnique.mockResolvedValue(null);
});

describe("choosing where the instance puts files", () => {
    it("never offers somebody's own drive", async () => {
        await storageTargetOptions();
        expect(findMany.mock.calls[0][0].where).toEqual({ kind: { not: "personal" } });
    });

    it("ignores a stored choice that names one", async () => {
        // Not reachable through the picker, so this is a stale value or a
        // hand-set one - and either way it must fall through to the rule rather
        // than start writing the instance's files into a person's folder.
        findUnique.mockResolvedValue({
            id: "drive-of-ana",
            name: "My files",
            kind: "personal"
        } as never);

        const target = await resolveTargetChoice("drive-of-ana");

        expect(target.id).toBe("local");
        expect(target.automatic).toBe(true);
    });

    it("still honours a choice that names a real storage", async () => {
        findUnique.mockResolvedValue({ id: "nas-1", name: "Attic", kind: "smb" } as never);

        const target = await resolveTargetChoice("nas-1");

        expect(target).toEqual({ id: "nas-1", name: "Attic", automatic: false });
    });

    it("prefers a NAS when nobody has chosen, and a personal drive is not one", async () => {
        findMany.mockResolvedValue([{ id: "nas-1", name: "Attic", kind: "smb" }] as never);

        const target = await resolveTargetChoice(null);

        expect(target.id).toBe("nas-1");
        // The automatic rule asks for NAS kinds by name, so a personal drive
        // could never be picked up by it even if the list were unfiltered.
        expect(findMany.mock.calls[0][0].where.kind.in).not.toContain("personal");
    });
});

describe("taking a storage out", () => {
    it("does not offer, or accept, a personal drive", async () => {
        vi.resetModules();
        const connectionFindFirst = vi.fn(async () => null);
        const connectionFindMany = vi.fn(async () => []);
        vi.doMock("@polaris/db", () => ({
            prisma: {
                storageConnection: { findFirst: connectionFindFirst, findMany: connectionFindMany },
                volume: { findMany: vi.fn(async () => []), updateMany: vi.fn() },
                share: { count: vi.fn(async () => 0) },
                fileRequest: { count: vi.fn(async () => 0) }
            }
        }));
        vi.doMock("@/lib/storage-service", () => ({
            deleteConnection: vi.fn(),
            getDriver: vi.fn()
        }));
        vi.doMock("@/lib/deploy-service", () => ({ deployAndWait: vi.fn() }));

        const { getConnectionRemovalPlan } = await import(
            "../../src/lib/connection-removal-service"
        );
        await getConnectionRemovalPlan(OWNER, "some-connection");

        // The connection being removed is looked up with the filter on, so a
        // personal drive answers "not found" rather than being taken apart.
        expect(connectionFindFirst.mock.calls[0][0].where.kind).toEqual({ not: "personal" });
    });
});
