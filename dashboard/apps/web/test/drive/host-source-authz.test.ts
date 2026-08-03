/**
 * A registered server browsed in Drive.
 *
 * Its connection id is `host:<uuid>`, which is not a value the storage-connection
 * column can even hold - asking for it there is a database error, not a miss, and
 * that is what used to reach the browser as "unable to list this location". So
 * what is pinned here is that the server is resolved as a server: the Host row
 * decides, the connection table is never consulted, and ownership still gates it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findUniqueUser = vi.fn();
const findUniqueHost = vi.fn();
const findUniqueConnection = vi.fn(() => {
    throw new Error("the storage-connection table must not be asked about a server");
});
const userHasPermission = vi.fn(async () => true);

vi.mock("@polaris/db", () => ({
    prisma: {
        user: { findUnique: findUniqueUser },
        host: { findUnique: findUniqueHost },
        storageConnection: { findUnique: findUniqueConnection }
    }
}));
vi.mock("@polaris/auth", () => ({ userHasPermission }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_AUTH_SECRET: "secret" }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/storage-service", () => ({
    CONTAINER_CONNECTION_PREFIX: "container:",
    HOST_CONNECTION_PREFIX: "host:",
    getDriverForConnection: vi.fn()
}));
vi.mock("@/lib/drive-acl-service", () => ({ canAccessDrive: async () => false }));
vi.mock("@/lib/access-lock-service", () => ({
    findLockForPath: async () => null,
    lockUnlockCookie: (id: string) => `lock_${id}`,
    verifyLockUnlock: () => false
}));

const { authorizeDrive, DriveAccessError } = await import("../../src/lib/drive-authz");

const OWNER = "018f2b7a-0000-7000-8000-0000000000a1";
const OTHER = "018f2b7a-0000-7000-8000-0000000000a2";
const HOST = "018f2b7a-0000-7000-8000-0000000000b1";
const SOURCE = `host:${HOST}`;

describe("a server as a Drive source", () => {
    beforeEach(() => {
        findUniqueUser.mockReset();
        findUniqueHost.mockReset();
        userHasPermission.mockClear();
        findUniqueHost.mockResolvedValue({ ownerId: OWNER });
        findUniqueUser.mockResolvedValue({ isAdmin: false });
    });

    it("lets the owner browse it, without touching the connection table", async () => {
        await expect(authorizeDrive(OWNER, SOURCE, "var/log", "read")).resolves.toBeUndefined();
        expect(findUniqueHost).toHaveBeenCalledWith({ where: { id: HOST }, select: { ownerId: true } });
        expect(findUniqueConnection).not.toHaveBeenCalled();
    });

    it("still asks for the Drive capability the verb needs", async () => {
        userHasPermission.mockResolvedValueOnce(false);
        await expect(authorizeDrive(OWNER, SOURCE, "", "write")).rejects.toBeInstanceOf(DriveAccessError);
    });

    it("refuses somebody else's server", async () => {
        await expect(authorizeDrive(OTHER, SOURCE, "", "read")).rejects.toBeInstanceOf(DriveAccessError);
    });

    it("lets an admin in without owning it", async () => {
        findUniqueUser.mockResolvedValue({ isAdmin: true });
        await expect(authorizeDrive(OTHER, SOURCE, "", "delete")).resolves.toBeUndefined();
    });

    it("refuses a server that is no longer registered", async () => {
        findUniqueHost.mockResolvedValue(null);
        await expect(authorizeDrive(OWNER, SOURCE, "", "read")).rejects.toBeInstanceOf(DriveAccessError);
    });
});
