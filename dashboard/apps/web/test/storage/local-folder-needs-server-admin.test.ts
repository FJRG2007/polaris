/**
 * A "Local folder" connection opens a folder of the server's own disk with the
 * web process's permissions, so it opens only for an owner who manages servers
 * (VULN-0037). The check sits where every connection opens, so one a member
 * made before the rule existed is refused as well - from the owner's Drive, a
 * share or a background job alike.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ID = "018f2b7a-0000-7000-8000-0000000000d1";
const OWNER = "018f2b7a-0000-7000-8000-0000000000d2";

let row: Record<string, unknown>;
let owner: { isAdmin: boolean } | null;
let systemManage: boolean;

const createDriver = vi.fn(() => ({ connect: vi.fn(async () => undefined) }));
const userHasPermission = vi.fn(async () => systemManage);

vi.mock("@polaris/db", () => ({
    Prisma: { DbNull: null },
    prisma: {
        storageConnection: {
            findUnique: vi.fn(async () => row),
            findFirst: vi.fn(async () => row)
        },
        user: { findUnique: vi.fn(async () => owner) }
    }
}));
vi.mock("@polaris/auth", () => ({ userHasPermission }));
vi.mock("@polaris/config", () => ({
    getCapabilities: () => ({ nativeMounts: false }),
    loadEnv: () => ({ POLARIS_MASTER_KEY: "fixture-key", POLARIS_DATA_DIR: "/var/polaris" })
}));
vi.mock("@polaris/hostd-client", () => ({ HostdClient: vi.fn() }));
vi.mock("@polaris/storage", () => ({
    createDriver,
    decryptCredentials: vi.fn(),
    encryptCredentials: vi.fn(),
    keyFingerprint: vi.fn(),
    LocalDriver: vi.fn(),
    ScopedDriver: vi.fn(),
    SftpDriver: vi.fn(),
    SmbDriver: vi.fn()
}));
vi.mock("@/lib/connection-pool", () => ({
    borrowSftp: vi.fn(),
    borrowSmb: vi.fn(),
    dropStorageConnection: vi.fn()
}));
vi.mock("@/lib/smb-shares", () => ({ listSmbShares: vi.fn() }));
vi.mock("@/lib/deploy/container-driver", () => ({ ContainerDriver: vi.fn() }));
vi.mock("@/lib/connections/storage-token", () => ({ linkedAccountToken: vi.fn() }));
vi.mock("@/lib/unifi-unas", () => ({ fetchUnasMetrics: vi.fn() }));
vi.mock("@/lib/metrics-history-service", () => ({ deleteMetricsForSubject: vi.fn() }));
vi.mock("@/lib/drive-acl-service", () => ({
    grantedConnectionIds: vi.fn(),
    grantedRootPath: vi.fn()
}));
vi.mock("@/lib/container-files-service", () => ({
    resolveContainerName: vi.fn(),
    resolveLocalContainer: vi.fn()
}));
vi.mock("@/lib/host-service", () => ({
    getHostConnection: vi.fn(),
    getHostConnectionUnscoped: vi.fn(),
    listHosts: vi.fn()
}));
vi.mock("@/lib/storage-alert", () => ({ reportStorageMoved: vi.fn() }));
vi.mock("@/lib/storage-target", () => ({ forgetStorageFailure: vi.fn() }));
vi.mock("@/lib/storage-returns", () => ({ returnFallbackFiles: vi.fn(async () => undefined) }));

const service = await import("@/lib/storage-service");

beforeEach(() => {
    vi.clearAllMocks();
    owner = { isAdmin: false };
    systemManage = false;
    row = {
        id: ID,
        name: "Server root",
        kind: "local",
        ownerId: OWNER,
        config: JSON.stringify({ kind: "local", root: "/" }),
        encryptedCredential: null,
        credentialNonce: null,
        credentialKeyId: null
    };
});

describe("a Local folder connection", () => {
    it("does not open for an owner who does not manage servers", async () => {
        await expect(service.getDriverForConnection(ID)).rejects.toThrow(
            service.SERVER_FOLDER_REFUSED
        );
        await expect(service.getDriver(ID, OWNER)).rejects.toThrow(service.SERVER_FOLDER_REFUSED);
        expect(createDriver).not.toHaveBeenCalled();
    });

    it("does not open when its owner is gone", async () => {
        owner = null;
        await expect(service.getDriverForConnection(ID)).rejects.toThrow(
            service.SERVER_FOLDER_REFUSED
        );
        expect(createDriver).not.toHaveBeenCalled();
    });

    it("opens for an administrator, or an owner who manages servers", async () => {
        owner = { isAdmin: true };
        await service.getDriverForConnection(ID);
        expect(createDriver).toHaveBeenCalledTimes(1);

        owner = { isAdmin: false };
        systemManage = true;
        await service.getDriverForConnection(ID);
        expect(userHasPermission).toHaveBeenCalledWith(OWNER, "system.manage");
        expect(createDriver).toHaveBeenCalledTimes(2);
    });

    it("leaves every other kind alone", async () => {
        row = {
            ...row,
            kind: "webdav",
            config: JSON.stringify({ kind: "webdav", baseUrl: "https://dav.example.test" })
        };
        await service.getDriverForConnection(ID);
        expect(createDriver).toHaveBeenCalledTimes(1);
    });
});
