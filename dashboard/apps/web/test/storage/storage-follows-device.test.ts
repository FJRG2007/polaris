/**
 * A NAS that took a new DHCP lease is found again on its network and followed -
 * and only when it proves to be the same device.
 *
 * The incident: a NAS was configured at .129; its lease moved it to .134;
 * nothing answered at .129 and Polaris kept dialling it. These run that story
 * against a fake network (a neighbour table and an SMB answer per address), plus
 * the ways it must NOT end: a different SMB server at the new address, one that
 * picked up the old address, and a NAS that is simply off.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceIdentity } from "@/lib/storage-whereabouts/identity";
import type { SmbProbeResult } from "@/lib/storage-whereabouts/smb-probe";

const ID = "018f2b7a-0000-7000-8000-0000000000a1";
const NAS: DeviceIdentity = {
    mac: "00:00:5e:00:53:50",
    serverGuid: "0123456789abcdef0123456789abcdef",
    netbiosName: "OFFICE-NAS"
};

/** The connection row, as the database holds it. */
let row: {
    id: string;
    name: string;
    kind: string;
    config: string;
    deviceIdentity: unknown;
};

const updateMany = vi.fn(
    async (args: {
        where: { config: string };
        data: { config?: string; deviceIdentity?: unknown };
    }) => {
        if (args.where.config !== row.config) return { count: 0 };
        row = {
            ...row,
            ...(args.data.config ? { config: args.data.config } : {}),
            ...(args.data.deviceIdentity !== undefined
                ? { deviceIdentity: args.data.deviceIdentity }
                : {})
        };
        return { count: 1 };
    }
);

vi.mock("@polaris/db", () => ({
    Prisma: { DbNull: null },
    prisma: {
        storageConnection: {
            findUnique: vi.fn(async () => row),
            findMany: vi.fn(async () => [row]),
            updateMany: (args: never) => updateMany(args)
        }
    }
}));

const reportStorageMoved = vi.fn(async () => undefined);
const forgetConnectionState = vi.fn();
const forgetStorageFailure = vi.fn();
const returnFallbackFiles = vi.fn(async () => ({ moved: 0, removed: 0, failed: 0 }));
vi.mock("@/lib/storage-alert", () => ({ reportStorageMoved }));
vi.mock("@/lib/storage-service", () => ({ forgetConnectionState }));
vi.mock("@/lib/storage-target", () => ({ forgetStorageFailure }));
vi.mock("@/lib/storage-returns", () => ({ returnFallbackFiles }));
vi.mock("@/lib/storage-whereabouts/neighbours", () => ({
    readNeighbourTable: vi.fn(async () => new Map())
}));
vi.mock("@/lib/storage-whereabouts/smb-probe", () => ({ probeSmbIdentity: vi.fn() }));

const follow = await import("@/lib/storage-whereabouts/follow");

/** Who answers on 445 at each address, and what the host's table says. */
let devices: Map<string, DeviceIdentity>;
let table: Map<string, string>;
/** Hardware addresses the host learns only once something has talked to them -
 *  which is what the sweep does. */
let learnedBySweep: Map<string, string>;
const probed: string[] = [];

function network() {
    follow.useNetwork({
        probe: async (address): Promise<SmbProbeResult> => {
            probed.push(address);
            const found = devices.get(address);
            if (learnedBySweep.has(address)) table.set(address, learnedBySweep.get(address)!);
            if (!found) return { ok: false, reason: "closed", detail: "EHOSTUNREACH" };
            const { mac: _mac, ...smb } = found;
            return { ok: true, identity: smb };
        },
        neighbours: async () => new Map(table)
    });
}

function connection(identity: DeviceIdentity | null, host = "10.0.1.129") {
    row = {
        id: ID,
        name: "Office NAS",
        kind: "unifi-unas",
        config: JSON.stringify({
            kind: "unifi-unas",
            host,
            username: "fixture-user",
            secure: true,
            smbShare: "Share"
        }),
        deviceIdentity: identity
            ? { ...identity, address: host, seenAt: "2026-10-01T10:00:00.000Z" }
            : null
    };
}

function hostOf(): string {
    return (JSON.parse(row.config) as { host: string }).host;
}

beforeEach(() => {
    vi.clearAllMocks();
    probed.length = 0;
    devices = new Map();
    table = new Map();
    learnedBySweep = new Map();
    network();
});

describe("a NAS whose lease moved", () => {
    it("is found by its hardware address in the host's table, followed, and announced", async () => {
        connection(NAS);
        devices.set("10.0.1.134", NAS);
        table.set("10.0.1.134", NAS.mac!);

        const outcome = await follow.searchFor(ID);

        expect(outcome).toEqual({
            kind: "followed",
            from: "10.0.1.129",
            to: "10.0.1.134",
            mac: NAS.mac
        });
        expect(hostOf()).toBe("10.0.1.134");
        expect(row.deviceIdentity).toMatchObject({ address: "10.0.1.134", mac: NAS.mac });
        await vi.waitFor(() => expect(reportStorageMoved).toHaveBeenCalled());
        expect(reportStorageMoved).toHaveBeenCalledWith({
            id: ID,
            name: "Office NAS",
            from: "10.0.1.129",
            to: "10.0.1.134",
            mac: NAS.mac
        });
        expect(forgetConnectionState).toHaveBeenCalledWith(ID);
        expect(forgetStorageFailure).toHaveBeenCalledWith(ID);
        // Found in the table: nothing else on the network was asked.
        expect(probed).toEqual(["10.0.1.129", "10.0.1.134"]);
    });

    it("is found by sweeping the /24 when the host has not spoken to it yet", async () => {
        connection(NAS);
        devices.set("10.0.1.20", {
            serverGuid: "ffffffffffffffffffffffffffff0001",
            netbiosName: "PRINTER"
        });
        devices.set("10.0.1.134", NAS);

        const outcome = await follow.searchFor(ID);

        expect(outcome).toMatchObject({ kind: "followed", to: "10.0.1.134" });
        expect(hostOf()).toBe("10.0.1.134");
    });

    it("is recognised by hardware address after the sweep when its GUID changed on restart", async () => {
        connection(NAS);
        devices.set("10.0.1.134", { ...NAS, serverGuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
        learnedBySweep.set("10.0.1.134", NAS.mac!);

        const outcome = await follow.searchFor(ID);

        expect(outcome).toMatchObject({ kind: "followed", to: "10.0.1.134", mac: NAS.mac });
        expect(row.deviceIdentity).toMatchObject({
            serverGuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        });
    });
});

describe("what must not be followed", () => {
    it("a different SMB server under the same name", async () => {
        connection(NAS);
        devices.set("10.0.1.134", {
            serverGuid: "ffffffffffffffffffffffffffff0002",
            netbiosName: "OFFICE-NAS"
        });
        learnedBySweep.set("10.0.1.134", "aa:bb:cc:dd:ee:ff");

        const outcome = await follow.searchFor(ID);

        expect(outcome).toEqual({ kind: "gone", address: "10.0.1.129" });
        expect(hostOf()).toBe("10.0.1.129");
        expect(updateMany).not.toHaveBeenCalled();
        expect(reportStorageMoved).not.toHaveBeenCalled();
    });

    it("anything at all, when it is off: it is reported gone", async () => {
        connection(NAS);
        expect(await follow.searchFor(ID)).toEqual({ kind: "gone", address: "10.0.1.129" });
        // The whole /24 was asked, and nothing else.
        expect(new Set(probed).size).toBe(254);
        expect(probed.every((address) => address.startsWith("10.0.1."))).toBe(true);
    });

    it("anything, when nothing was ever remembered: it lists who answers instead", async () => {
        connection(null);
        devices.set("10.0.1.134", NAS);
        table.set("10.0.1.134", NAS.mac!);

        const outcome = await follow.searchFor(ID);

        expect(outcome).toEqual({
            kind: "candidates",
            candidates: [{ address: "10.0.1.134", label: "OFFICE-NAS", mac: NAS.mac }]
        });
        expect(updateMany).not.toHaveBeenCalled();
    });

    it("nothing, when it is where it was", async () => {
        connection(NAS);
        devices.set("10.0.1.129", NAS);
        expect(await follow.searchFor(ID)).toEqual({ kind: "answering", address: "10.0.1.129" });
        expect(probed).toEqual(["10.0.1.129"]);
    });
});

describe("a search past its deadline", () => {
    it("stops sweeping and does not follow a device it finds late", async () => {
        vi.useFakeTimers();
        try {
            connection(NAS);
            devices.set("10.0.1.134", NAS);
            table.set("10.0.1.134", NAS.mac!);
            let release!: () => void;
            const held = new Promise<void>((resolve) => (release = resolve));
            follow.useNetwork({
                probe: async (address): Promise<SmbProbeResult> => {
                    probed.push(address);
                    await held;
                    const found = devices.get(address);
                    if (!found) return { ok: false, reason: "closed", detail: "EHOSTUNREACH" };
                    const { mac: _mac, ...smb } = found;
                    return { ok: true, identity: smb };
                },
                neighbours: async () => new Map(table)
            });

            const outcome = follow.searchFor(ID);
            await vi.advanceTimersByTimeAsync(61_000);
            expect(await outcome).toEqual({ kind: "unsupported" });

            release();
            await vi.advanceTimersByTimeAsync(0);
            expect(updateMany).not.toHaveBeenCalled();
            expect(reportStorageMoved).not.toHaveBeenCalled();
            expect(hostOf()).toBe("10.0.1.129");
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("how often it looks", () => {
    it("answers a second search from memory, and a pressed button only after a short floor", async () => {
        connection(NAS);
        await follow.searchFor(ID);
        const asked = probed.length;

        await follow.searchFor(ID);
        await follow.searchFor(ID, { force: true });
        expect(probed.length).toBe(asked);
        expect(follow.lastSearch(ID)?.outcome).toEqual({ kind: "gone", address: "10.0.1.129" });
    });

    it("shares one search between callers that ask at once", async () => {
        connection(NAS);
        const [one, two] = await Promise.all([follow.searchFor(ID), follow.searchFor(ID)]);
        expect(one).toEqual(two);
        expect(probed.filter((address) => address === "10.0.1.129")).toHaveLength(1);
    });
});

describe("before the password goes anywhere", () => {
    it("lets it through to the remembered device", async () => {
        connection(NAS);
        devices.set("10.0.1.129", NAS);
        await expect(follow.confirmBeforeCredentials(row)).resolves.toBeUndefined();
    });

    it("refuses a different SMB server that picked up the old address", async () => {
        connection(NAS);
        devices.set("10.0.1.129", {
            serverGuid: "ffffffffffffffffffffffffffff0003",
            netbiosName: "DESKTOP-7"
        });
        table.set("10.0.1.129", "aa:bb:cc:dd:ee:01");
        await expect(follow.confirmBeforeCredentials(row)).rejects.toBeInstanceOf(
            follow.DeviceNotConfirmed
        );
        // It went looking for the real one instead, found nothing to follow, and
        // says who holds the address rather than calling the NAS off.
        expect(await follow.searchFor(ID)).toEqual({
            kind: "impostor",
            address: "10.0.1.129",
            label: "DESKTOP-7"
        });
        expect(hostOf()).toBe("10.0.1.129");
    });

    it("refuses when nothing answers, rather than signing in to whatever answers later", async () => {
        connection(NAS);
        await expect(follow.confirmBeforeCredentials(row)).rejects.toThrow(/did not answer/);
        await follow.searchFor(ID);
    });

    it("has nothing to check for a connection that never remembered a device", async () => {
        connection(null);
        await expect(follow.confirmBeforeCredentials(row)).resolves.toBeUndefined();
        expect(probed).toEqual([]);
    });
});

describe("an address somebody typed", () => {
    it("is refused when a different device answers there and the password is kept", async () => {
        connection(NAS);
        devices.set("10.0.1.50", {
            serverGuid: "ffffffffffffffffffffffffffff0004",
            netbiosName: "OTHER"
        });
        await expect(
            follow.identityForEdit(row, { kind: "unifi-unas", host: "10.0.1.50" }, false)
        ).rejects.toBeInstanceOf(follow.AddressRefused);
    });

    it("is refused when nothing answers there", async () => {
        connection(NAS);
        await expect(
            follow.identityForEdit(row, { kind: "unifi-unas", host: "10.0.1.51" }, false)
        ).rejects.toMatchObject({ check: "silent" });
    });

    it("keeps the identity when the same device answers there", async () => {
        connection(NAS);
        devices.set("10.0.1.134", NAS);
        const identity = await follow.identityForEdit(
            row,
            { kind: "unifi-unas", host: "10.0.1.134" },
            false
        );
        expect(identity).toMatchObject({ serverGuid: NAS.serverGuid, address: "10.0.1.134" });
    });

    it("forgets the identity when new credentials come with the new address", async () => {
        connection(NAS);
        expect(
            await follow.identityForEdit(row, { kind: "unifi-unas", host: "10.0.0.5" }, true)
        ).toBeNull();
        expect(probed).toEqual([]);
    });

    it("leaves everything alone when the address did not change", async () => {
        connection(NAS);
        expect(
            await follow.identityForEdit(row, { kind: "unifi-unas", host: "10.0.1.129" }, false)
        ).toBeUndefined();
    });
});

describe("remembering", () => {
    it("keeps who answered once the credentials have worked, hardware address included", async () => {
        connection(null);
        devices.set("10.0.1.129", NAS);
        table.set("10.0.1.129", NAS.mac!);
        await follow.rememberAfterSuccess(row);
        expect(row.deviceIdentity).toMatchObject({ ...NAS, address: "10.0.1.129" });
    });
});
