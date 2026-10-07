/**
 * Drive mounting a share again restarts the services still bound to the old mount.
 *
 * When a NAS came back on a new address, Drive was the first to ask for the share:
 * the daemon found the old mount dead, mounted it again, and said so - and Drive
 * took the new mount and said nothing, so a service started days earlier kept the
 * dead one and every file on its volumes answered "Host is down".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ID = "018f2b7a-0000-7000-8000-0000000000d4";

let row: Record<string, unknown>;
let created = true;

const createMount = vi.fn(async () => ({ created }));
const smbConnect = vi.fn(async () => undefined);
const SmbDriver = vi.fn(function (this: Record<string, unknown>) {
    this.connect = smbConnect;
    this.dispose = vi.fn(async () => undefined);
});
const decryptCredentials = vi.fn(() => ({ kind: "unifi-unas", password: "fixture-password" }));
const borrowSmb = vi.fn();
const restartAppsOnShare = vi.fn(async () => undefined);
vi.mock("@/lib/deploy-service", () => ({ restartAppsOnShare }));
// Where the device went is its own suite; here the address is taken as right.
vi.mock("@/lib/storage-whereabouts/follow", () => ({
    isFollowedKind: () => false,
    forgetConnection: vi.fn()
}));

vi.mock("@polaris/db", () => ({
    Prisma: { DbNull: null },
    prisma: {
        storageConnection: {
            findUnique: vi.fn(async () => row),
            findFirst: vi.fn(async () => row),
            findMany: vi.fn(async () => [row]),
            updateMany: vi.fn(
                async (args: { where: { config: string }; data: Record<string, unknown> }) => {
                    if (args.where.config !== row.config) return { count: 0 };
                    row = { ...row, ...args.data };
                    return { count: 1 };
                }
            )
        }
    }
}));
vi.mock("@polaris/config", () => ({
    getCapabilities: () => ({ nativeMounts: true }),
    loadEnv: () => ({ POLARIS_MASTER_KEY: "fixture-key", POLARIS_DATA_DIR: "/var/polaris" })
}));
vi.mock("@polaris/hostd-client", () => ({
    HostdClient: vi.fn(function (this: Record<string, unknown>) {
        this.createMount = createMount;
    })
}));
vi.mock("@polaris/storage", () => ({
    createDriver: vi.fn(),
    decryptCredentials,
    encryptCredentials: vi.fn(),
    keyFingerprint: vi.fn(),
    LocalDriver: vi.fn(function (this: Record<string, unknown>) {
        this.connect = vi.fn(async () => undefined);
        this.dispose = vi.fn(async () => undefined);
    }),
    ScopedDriver: vi.fn(),
    SftpDriver: vi.fn(),
    SmbDriver
}));
vi.mock("@/lib/connection-pool", () => ({
    borrowSftp: vi.fn(),
    borrowSmb,
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
const reportStorageMoved = vi.fn(async () => undefined);
vi.mock("@/lib/storage-alert", () => ({ reportStorageMoved }));
vi.mock("@/lib/storage-target", () => ({ forgetStorageFailure: vi.fn() }));
vi.mock("@/lib/storage-returns", () => ({ returnFallbackFiles: vi.fn(async () => undefined) }));
vi.mock("@/lib/storage-whereabouts/neighbours", () => ({
    readNeighbourTable: vi.fn(async () => new Map())
}));
vi.mock("@/lib/storage-whereabouts/smb-probe", () => ({ probeSmbIdentity: vi.fn() }));

const service = await import("@/lib/storage-service");

beforeEach(() => {
    vi.clearAllMocks();
    created = true;
    // Each case asks the daemon afresh rather than trusting the last one's mount.
    service.forgetConnectionState(ID);
    row = {
        id: ID,
        name: "Office NAS",
        kind: "unifi-unas",
        ownerId: "018f2b7a-0000-7000-8000-0000000000c3",
        config: JSON.stringify({
            kind: "unifi-unas",
            host: "10.0.1.129",
            username: "fixture-user",
            secure: true,
            smbShare: "Share"
        }),
        encryptedCredential: Buffer.from("cipher"),
        credentialNonce: Buffer.from("nonce"),
        credentialKeyId: "k",
        deviceIdentity: null
    };
});

describe("Drive asking for a share", () => {
    it("restarts the services on this machine when the share had to be mounted again", async () => {
        await service.getDriverForConnection(ID);
        expect(createMount).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(restartAppsOnShare).toHaveBeenCalledWith(ID, null));
    });

    it("leaves them alone when the mount was already live", async () => {
        created = false;
        await service.getDriverForConnection(ID);
        expect(createMount).toHaveBeenCalledOnce();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(restartAppsOnShare).not.toHaveBeenCalled();
    });
});
