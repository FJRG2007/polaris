/**
 * A server that changed address, found again without a terminal.
 *
 * This is the failure people actually hit. A machine on a home or office network
 * holds its address on a DHCP lease; the lease moves - a reboot, a router
 * restart, a new device taking the number - and every screen in Polaris says the
 * server is not answering. Which is true of the address and false of the machine.
 *
 * Asking the machine where it has moved to does not work, because the asking
 * goes to the address that no longer reaches it. So Polaris looks: its own
 * network, the one port that server is recorded on, and every answer checked
 * against the host key already pinned to it.
 *
 * The host key is the whole safety argument and the whole correctness argument at
 * once. It is presented during the handshake, before a username or a key is
 * offered, so the neighbour's NAS with 22 open is refused without being handed
 * anything - and a machine that does present it is this server, wherever it has
 * ended up.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const HOST = "11111111-1111-4111-8111-111111111111";
const ADA = "22222222-2222-4222-8222-222222222222";

/** Polaris' own address on the network. */
let near: string | null = "192.168.1.50";
/** Where the server is recorded, which is where it no longer is. */
let recorded = "192.168.1.138";
/** Whether the machine answers where Polaris has it recorded. */
let answersAtRecorded = false;
/** Addresses with the port open, as the sweep would find them. */
let openPorts = new Set<string>();
/** The one address that presents this server's host key. */
let realAddress: string | null = null;

const probed: string[] = [];
const handshakes: string[] = [];
const updated = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: { host: { update: async (args: unknown) => updated(args) } }
}));

vi.mock("@/lib/host-address", () => ({ getHostLanIp: async () => near }));

vi.mock("@/lib/host-service", () => ({
    getHostConnection: async () => ({
        id: HOST,
        name: "lirio-0",
        address: recorded,
        port: 22,
        username: "polaris",
        auth: { method: "key" as const, privateKey: "key" },
        hostKey: "AAAApinned"
    })
}));

vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));

vi.mock("@/lib/connection-pool", () => ({
    borrowSsh: async () => {
        if (!answersAtRecorded) throw new Error("connect ETIMEDOUT");
        return { client: {}, release: () => undefined };
    }
}));

vi.mock("@/lib/server-status", () => ({
    probeTcp: async (address: string) => {
        probed.push(address);
        return { latencyMs: 1, detail: openPorts.has(address) ? null : "No answer" };
    }
}));

vi.mock("@polaris/ssh", () => ({
    execCommand: async () => ({ code: 0 }),
    openSshClient: async ({ host }: { host: string }) => {
        handshakes.push(host);
        // The pinned key is checked during the handshake, so a machine that is
        // not this one fails here - before anything is offered to it.
        if (host !== realAddress) throw new Error("host key verification failed");
        return { end: () => undefined };
    }
}));

const { findLocalPath, useLocalPath } = await import("../../src/lib/server-local-path");

beforeEach(() => {
    vi.clearAllMocks();
    probed.length = 0;
    handshakes.length = 0;
    near = "192.168.1.50";
    recorded = "192.168.1.138";
    answersAtRecorded = false;
    openPorts = new Set();
    realAddress = null;
});

describe("a machine whose address moved", () => {
    it("is found by its host key and reported as moved", async () => {
        openPorts = new Set(["192.168.1.1", "192.168.1.142"]);
        realAddress = "192.168.1.142";

        const path = await findLocalPath(HOST, ADA);

        expect(path).toEqual({ kind: "found", address: "192.168.1.142", moved: true });
    });

    it("only ever looks on the network Polaris is on", async () => {
        openPorts = new Set(["192.168.1.142"]);
        realAddress = "192.168.1.142";

        await findLocalPath(HOST, ADA);

        expect(probed.every((address) => address.startsWith("192.168.1."))).toBe(true);
        expect(probed.length).toBeLessThanOrEqual(254);
    });

    it("does not knock on Polaris' own door, or on the address that failed", async () => {
        openPorts = new Set(["192.168.1.142"]);
        realAddress = "192.168.1.142";

        await findLocalPath(HOST, ADA);

        // On a host-networked install Polaris' own address is the box this runs
        // on, and the recorded one has already been tried and failed.
        expect(probed).not.toContain("192.168.1.50");
        expect(probed).not.toContain("192.168.1.138");
    });

    it("only handshakes with what answered on the port", async () => {
        // A handshake is far more expensive than a connect, and the whole point
        // of the sweep is that it costs a second rather than a minute.
        openPorts = new Set(["192.168.1.7", "192.168.1.142"]);
        realAddress = "192.168.1.142";

        await findLocalPath(HOST, ADA);

        expect(handshakes.sort()).toEqual(["192.168.1.142", "192.168.1.7"]);
    });

    it("stops at the machine that answers with the key", async () => {
        openPorts = new Set(["192.168.1.142", "192.168.1.200"]);
        realAddress = "192.168.1.142";

        await findLocalPath(HOST, ADA);

        // Nothing to learn from the ones after it.
        expect(handshakes).not.toContain("192.168.1.200");
    });
});

describe("a machine that really is not there", () => {
    it("says so rather than guessing at an address", async () => {
        openPorts = new Set(["192.168.1.1", "192.168.1.7"]);
        realAddress = null;

        expect(await findLocalPath(HOST, ADA)).toEqual({ kind: "unreachable" });
    });

    it("does not look at all when Polaris does not know where it is itself", async () => {
        near = null;
        expect(await findLocalPath(HOST, ADA)).toEqual({ kind: "unknown" });
        expect(probed).toEqual([]);
    });
});

describe("a machine that is already reached directly", () => {
    it("has nothing to offer, once it has answered there", async () => {
        recorded = "192.168.1.99";
        answersAtRecorded = true;

        expect(await findLocalPath(HOST, ADA)).toEqual({ kind: "already", address: "192.168.1.99" });
        expect(probed).toEqual([]);
    });

    it("is still looked for when the local address reaches nothing", async () => {
        // The case this whole thing exists for: the recorded address is on the
        // right network and is simply not where the machine is any more. Reading
        // "near" as "reached" is what made this answer nothing useful.
        recorded = "192.168.1.138";
        answersAtRecorded = false;
        openPorts = new Set(["192.168.1.142"]);
        realAddress = "192.168.1.142";

        expect(await findLocalPath(HOST, ADA)).toEqual({
            kind: "found",
            address: "192.168.1.142",
            moved: true
        });
    });
});

describe("moving a server onto the address it was found at", () => {
    it("checks the key again before writing it down", async () => {
        // Two requests with somebody's decision in between, and what is written
        // is the address every future connection takes: a wrong one is a server
        // that has disappeared with no way back that does not involve a terminal.
        realAddress = "192.168.1.142";

        expect(await useLocalPath(HOST, ADA, "192.168.1.142")).toEqual({});
        expect(updated).toHaveBeenCalledWith(
            expect.objectContaining({ data: { address: "192.168.1.142" } })
        );
    });

    it("refuses an address that does not answer as this server", async () => {
        realAddress = "192.168.1.142";

        const result = await useLocalPath(HOST, ADA, "192.168.1.200");

        expect(result.error).toBeTruthy();
        expect(updated).not.toHaveBeenCalled();
    });
});
