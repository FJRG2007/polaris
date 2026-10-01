/**
 * A different SMB server at the old address never receives the stored password.
 *
 * When a NAS's lease moves, the router may lend its old address to something
 * else - a laptop with file sharing on, another NAS. Polaris used to dial the
 * address and sign in to whatever answered: the kernel mount and the userspace
 * client both send the account and a response derived from the password. This
 * opens the real storage service against that situation and checks that neither
 * path is taken, that the password is not even decrypted, and that the real
 * device is looked for and followed instead.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceIdentity } from "@/lib/storage-whereabouts/identity";
import type { SmbProbeResult } from "@/lib/storage-whereabouts/smb-probe";

const ID = "018f2b7a-0000-7000-8000-0000000000b2";
const NAS: DeviceIdentity = {
    mac: "6c:63:f8:6e:53:50",
    serverGuid: "0123456789abcdef0123456789abcdef",
    netbiosName: "UNAS-PRO"
};

let row: Record<string, unknown>;

const createMount = vi.fn(async () => ({ created: true }));
const smbConnect = vi.fn(async () => undefined);
const SmbDriver = vi.fn(function (this: Record<string, unknown>, options: { session: unknown }) {
    this.options = options;
    this.connect = smbConnect;
    this.dispose = vi.fn(async () => undefined);
});
const decryptCredentials = vi.fn(() => ({ kind: "unifi-unas", password: "fixture-password" }));
const borrowSmb = vi.fn();

vi.mock("@polaris/db", () => ({
    Prisma: { DbNull: null },
    prisma: {
        storageConnection: {
            findUnique: vi.fn(async () => row),
            findFirst: vi.fn(async () => row),
            findMany: vi.fn(async () => [row]),
            updateMany: vi.fn(async (args: { where: { config: string }; data: Record<string, unknown> }) => {
                if (args.where.config !== row.config) return { count: 0 };
                row = { ...row, ...args.data };
                return { count: 1 };
            })
        }
    }
}));
vi.mock("@polaris/config", () => ({
    // No kernel mounts: the userspace client is the path that would sign in.
    getCapabilities: () => ({ nativeMounts: false }),
    loadEnv: () => ({ POLARIS_MASTER_KEY: "fixture-key", POLARIS_DATA_DIR: "/var/polaris" })
}));
vi.mock("@polaris/hostd-client", () => ({ HostdClient: vi.fn(() => ({ createMount })) }));
vi.mock("@polaris/storage", () => ({
    createDriver: vi.fn(),
    decryptCredentials,
    encryptCredentials: vi.fn(),
    keyFingerprint: vi.fn(),
    LocalDriver: vi.fn(),
    ScopedDriver: vi.fn(),
    SftpDriver: vi.fn(),
    SmbDriver
}));
vi.mock("@/lib/connection-pool", () => ({ borrowSftp: vi.fn(), borrowSmb, dropStorageConnection: vi.fn() }));
vi.mock("@/lib/smb-shares", () => ({ listSmbShares: vi.fn() }));
vi.mock("@/lib/deploy/container-driver", () => ({ ContainerDriver: vi.fn() }));
vi.mock("@/lib/connections/storage-token", () => ({ linkedAccountToken: vi.fn() }));
vi.mock("@/lib/unifi-unas", () => ({ fetchUnasMetrics: vi.fn() }));
vi.mock("@/lib/metrics-history-service", () => ({ deleteMetricsForSubject: vi.fn() }));
vi.mock("@/lib/drive-acl-service", () => ({ grantedConnectionIds: vi.fn(), grantedRootPath: vi.fn() }));
vi.mock("@/lib/container-files-service", () => ({ resolveContainerName: vi.fn(), resolveLocalContainer: vi.fn() }));
vi.mock("@/lib/host-service", () => ({
    getHostConnection: vi.fn(),
    getHostConnectionUnscoped: vi.fn(),
    listHosts: vi.fn()
}));
const reportStorageMoved = vi.fn(async () => undefined);
vi.mock("@/lib/storage-alert", () => ({ reportStorageMoved }));
vi.mock("@/lib/storage-target", () => ({ forgetStorageFailure: vi.fn() }));
vi.mock("@/lib/storage-returns", () => ({ returnFallbackFiles: vi.fn(async () => undefined) }));
vi.mock("@/lib/storage-whereabouts/neighbours", () => ({ readNeighbourTable: vi.fn(async () => new Map()) }));
vi.mock("@/lib/storage-whereabouts/smb-probe", () => ({ probeSmbIdentity: vi.fn() }));

const service = await import("@/lib/storage-service");
const follow = await import("@/lib/storage-whereabouts/follow");

let devices: Map<string, DeviceIdentity>;
let table: Map<string, string>;

beforeEach(() => {
    vi.clearAllMocks();
    devices = new Map();
    table = new Map();
    follow.useNetwork({
        probe: async (address): Promise<SmbProbeResult> => {
            const found = devices.get(address);
            if (!found) return { ok: false, reason: "closed", detail: "EHOSTUNREACH" };
            const { mac: _mac, ...smb } = found;
            return { ok: true, identity: smb };
        },
        neighbours: async () => new Map(table)
    });
    row = {
        id: ID,
        name: "UNAS Pro",
        kind: "unifi-unas",
        ownerId: "018f2b7a-0000-7000-8000-0000000000c3",
        config: JSON.stringify({
            kind: "unifi-unas",
            host: "192.168.1.129",
            username: "fixture-user",
            secure: true,
            smbShare: "Share"
        }),
        encryptedCredential: Buffer.from("cipher"),
        credentialNonce: Buffer.from("nonce"),
        credentialKeyId: "k",
        deviceIdentity: { ...NAS, address: "192.168.1.129", seenAt: "2026-10-01T10:00:00.000Z" }
    };
});

describe("a different SMB server at the old address", () => {
    it("is never signed in to, and the real device is followed instead", async () => {
        devices.set("192.168.1.129", { serverGuid: "ffffffffffffffffffffffffffff0009", netbiosName: "LAPTOP" });
        table.set("192.168.1.129", "aa:bb:cc:dd:ee:09");
        devices.set("192.168.1.134", NAS);
        table.set("192.168.1.134", NAS.mac!);

        await expect(service.getDriverForConnection(ID)).rejects.toBeInstanceOf(follow.DeviceNotConfirmed);

        // Neither sign-in path ran, and the password was never even decrypted.
        expect(createMount).not.toHaveBeenCalled();
        expect(SmbDriver).not.toHaveBeenCalled();
        expect(borrowSmb).not.toHaveBeenCalled();
        expect(decryptCredentials).not.toHaveBeenCalled();

        // The search the refusal started finds the NAS where it went.
        await expect(follow.searchFor(ID)).resolves.toMatchObject({ kind: "followed", to: "192.168.1.134" });
        expect(JSON.parse(row.config as string).host).toBe("192.168.1.134");
        await vi.waitFor(() => expect(reportStorageMoved).toHaveBeenCalledOnce());

        // And the next open signs in there.
        const driver = await service.getDriverForConnection(ID);
        expect(driver).toBeDefined();
        expect(SmbDriver).toHaveBeenCalledOnce();
        expect(smbConnect).toHaveBeenCalledOnce();
    });

    it("is not given the password for the console sign-in either", async () => {
        devices.set("192.168.1.129", { serverGuid: "ffffffffffffffffffffffffffff0009", netbiosName: "LAPTOP" });
        await expect(service.getUnasMetrics(ID, row.ownerId as string)).rejects.toBeInstanceOf(
            follow.DeviceNotConfirmed
        );
        expect(decryptCredentials).not.toHaveBeenCalled();
        await follow.searchFor(ID);
    });

    it("is not mounted by the deploy pipeline either", async () => {
        devices.set("192.168.1.129", { serverGuid: "ffffffffffffffffffffffffffff0009", netbiosName: "LAPTOP" });
        await expect(service.resolveMountTarget(ID, row.ownerId as string)).rejects.toBeInstanceOf(
            follow.DeviceNotConfirmed
        );
        expect(decryptCredentials).not.toHaveBeenCalled();
        await follow.searchFor(ID);
    });
});

describe("the device it remembers", () => {
    it("is signed in to as before", async () => {
        devices.set("192.168.1.129", NAS);
        await expect(service.getDriverForConnection(ID)).resolves.toBeDefined();
        expect(SmbDriver).toHaveBeenCalledOnce();
        expect(decryptCredentials).toHaveBeenCalled();
    });
});
