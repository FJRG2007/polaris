/**
 * Who gets into a company's shelf.
 *
 * A connection with an `orgId` belongs to no account, so the ownership question
 * every other location answers is not available here and the organization's own
 * roster answers instead. Two things about that are easy to get subtly wrong and
 * expensive to find out about later: being answered by the access resolver is
 * not the same as being on the roster, and per-folder rules have to keep meaning
 * what they mean everywhere else - a deny wins.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findUniqueUser = vi.fn();
const findUniqueConnection = vi.fn();
const resolveOrgAccess = vi.fn();
const resolveDriveDecision = vi.fn();
const canAccessDrive = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        user: { findUnique: findUniqueUser },
        storageConnection: { findUnique: findUniqueConnection }
    }
}));
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => true }));
vi.mock("@/lib/effective-access", () => ({
    effectiveCan: async () => true,
    effectiveIsAdmin: async (_userId: string, isAdmin: boolean) => isAdmin
}));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_AUTH_SECRET: "secret" }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/storage-service", () => ({
    CONTAINER_CONNECTION_PREFIX: "container:",
    HOST_CONNECTION_PREFIX: "host:",
    getDriverForConnection: vi.fn()
}));
vi.mock("@/lib/drive-acl-service", () => ({ canAccessDrive, resolveDriveDecision }));
vi.mock("@/lib/access-lock-service", () => ({
    findLockForPath: async () => null,
    lockUnlockCookie: (id: string) => `lock_${id}`,
    verifyLockUnlock: () => false
}));
vi.mock("@/lib/orgs/org-service", () => ({
    resolveOrgAccess,
    orgCan: (access: { permissions: string[] } | null, permission: string) =>
        access !== null && access.permissions.some((held) => held === "*" || held === permission)
}));

const { authorizeDrive, DriveAccessError } = await import("@/lib/drive-authz");

const ORG = "018f2b7a-0000-7000-8000-0000000000c1";
const PERSON = "018f2b7a-0000-7000-8000-0000000000a1";

beforeEach(() => {
    vi.clearAllMocks();
    findUniqueUser.mockResolvedValue({ isAdmin: false });
    findUniqueConnection.mockResolvedValue({ ownerId: null, orgId: ORG });
    resolveDriveDecision.mockResolvedValue("implicit-deny");
    canAccessDrive.mockResolvedValue(false);
});

describe("an organization's Drive", () => {
    it("opens for somebody on the roster", async () => {
        resolveOrgAccess.mockResolvedValue({ isOwner: false, permissions: ["org.read"] });
        await expect(authorizeDrive(PERSON, ORG, "contracts", "read")).resolves.toBeUndefined();
    });

    it("does not open for a successor, who is answered but is not on the roster", async () => {
        // `resolveOrgAccess` answers a named successor rather than turning them
        // away, so that the one screen they may open has something to resolve -
        // with nothing at all, `org.read` included. Reading `access !== null` as
        // "a member" hands them every file the company has while its owner is
        // alive.
        resolveOrgAccess.mockResolvedValue({
            isOwner: false,
            role: "successor",
            permissions: []
        });
        await expect(authorizeDrive(PERSON, ORG, "contracts", "read")).rejects.toBeInstanceOf(
            DriveAccessError
        );
    });

    it("opens for the owner, who is never a member row", async () => {
        resolveOrgAccess.mockResolvedValue({ isOwner: true, permissions: ["*"] });
        await expect(authorizeDrive(PERSON, ORG, "contracts", "read")).resolves.toBeUndefined();
    });

    it("lets the roster read and keeps writing to the permission", async () => {
        resolveOrgAccess.mockResolvedValue({ isOwner: false, permissions: ["org.read"] });
        await expect(authorizeDrive(PERSON, ORG, "contracts", "write")).rejects.toBeInstanceOf(
            DriveAccessError
        );
        resolveOrgAccess.mockResolvedValue({
            isOwner: false,
            permissions: ["org.read", "drive.manage"]
        });
        await expect(authorizeDrive(PERSON, ORG, "contracts", "write")).resolves.toBeUndefined();
    });

    it("obeys a deny written against somebody the roster lets in", async () => {
        // The per-folder rules are what narrows a company's shelf to a folder
        // only Legal opens. Asked only after the roster has refused, every deny
        // written against a member is a rule that silently does nothing.
        resolveOrgAccess.mockResolvedValue({
            isOwner: false,
            permissions: ["org.read", "drive.manage"]
        });
        resolveDriveDecision.mockResolvedValue("deny");
        await expect(authorizeDrive(PERSON, ORG, "legal", "read")).rejects.toBeInstanceOf(
            DriveAccessError
        );
    });

    it("still lets a rule reach somebody the roster does not", async () => {
        // A contractor given one directory and nothing else.
        resolveOrgAccess.mockResolvedValue(null);
        resolveDriveDecision.mockResolvedValue("allow");
        await expect(authorizeDrive(PERSON, ORG, "handover", "read")).resolves.toBeUndefined();
    });
});
