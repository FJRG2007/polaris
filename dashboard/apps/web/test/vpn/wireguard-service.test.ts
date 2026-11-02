import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const tx = vi.hoisted(() => ({ $executeRaw: vi.fn(async () => 1) }));
const db = vi.hoisted(() => ({
    $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(tx)),
    user: { findMany: vi.fn() },
    vpnProxyUsage: { findUnique: vi.fn(), upsert: vi.fn() },
    vpnAccess: { findUnique: vi.fn(), deleteMany: vi.fn(), upsert: vi.fn() },
    vpnNode: {
        create: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        delete: vi.fn(),
        update: vi.fn()
    },
    vpnPeer: { count: vi.fn(), create: vi.fn(), delete: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() }
}));
const script = vi.hoisted(() => ({ run: vi.fn(), setting: vi.fn(), taken: vi.fn() }));

vi.mock("@polaris/db", () => ({ prisma: db }));
vi.mock("@/lib/setting-store", () => ({ getSetting: script.setting, setSetting: vi.fn() }));
vi.mock("@/lib/deploy/server-edge", () => ({ edgeLauncher: () => "sh" }));
vi.mock("@/lib/app-edge", () => ({ edgeHostnameTaken: script.taken }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k" }) }));
vi.mock("@polaris/storage", () => ({
    decryptSecret: vi.fn(),
    encryptSecret: () => ({ ciphertext: "c", nonce: "n", keyId: "i" })
}));
vi.mock("@/lib/host-service", () => ({
    getHostConnectionUnscoped: async () => ({ username: "root", address: "host", port: 22 })
}));
vi.mock("@polaris/ssh", () => ({
    openSshClient: async () => ({ end: () => undefined }),
    execCommand: script.run
}));

import * as service from "@/lib/vpn/wireguard-service";

const node = {
    id: NODE_ID,
    hostId: "host",
    subnetIndex: 0,
    port: 51820,
    exit: "direct",
    endpoint: "vpn.example.test",
    publicKey: `${"A".repeat(43)}=`
};
const admin = { id: "admin", isAdmin: true };
const person = { id: "person", isAdmin: false };
const device = { nodeId: NODE_ID, name: "Phone", publicKey: `${"C".repeat(42)}E=` };

beforeEach(() => {
    vi.clearAllMocks();
    db.vpnAccess.findUnique.mockResolvedValue(null);
    db.vpnNode.findUnique.mockResolvedValue(node);
    db.vpnPeer.count.mockResolvedValue(0);
    db.vpnPeer.findMany.mockResolvedValue([]);
    db.vpnPeer.findUnique.mockResolvedValue(null);
    db.vpnPeer.create.mockImplementation(async ({ data }) => ({ id: "peer", ...data }));
    script.setting.mockResolvedValue(null);
    script.run.mockResolvedValue({ code: 0 });
    script.taken.mockResolvedValue(false);
    db.vpnNode.update.mockImplementation(async ({ data }) => ({ ...node, ...data }));
});

describe("who may add a device", () => {
    it("refuses somebody with no access while the VPN is not open", async () => {
        await expect(service.connectClient(person, device)).rejects.toMatchObject(
            { code: "noAccess" }
        );
    });

    it("lets everybody in once it is open", async () => {
        script.setting.mockResolvedValue("true");
        const made = await service.connectClient(person, device);
        expect(made.nodePublicKey).toBe(node.publicKey);
    });

    it("stops at the person's device limit", async () => {
        db.vpnPeer.count.mockResolvedValue(5);
        await expect(service.connectClient(admin, device)).rejects.toMatchObject({
            code: "deviceLimit"
        });
    });
});

describe("a device", () => {
    it("looks again when two take one address at once", async () => {
        db.vpnPeer.create.mockRejectedValueOnce(Object.assign(new Error("taken"), { code: "P2002" }));
        const made = await service.connectClient(admin, device);
        expect(db.vpnPeer.create).toHaveBeenCalledTimes(2);
        expect(made.deviceId).toBe("peer");
    });

    it("is taken back when the node cannot be told", async () => {
        script.run.mockResolvedValue({ code: 1 });
        await expect(service.connectClient(admin, device)).rejects.toMatchObject({
            code: "unreachable"
        });
        expect(db.vpnPeer.delete).toHaveBeenCalledWith({ where: { id: "peer" } });
    });
});

describe("removing a node", () => {
    it("keeps an unreachable node until asked to remove it anyway", async () => {
        script.run.mockResolvedValue({ code: 1 });
        await expect(service.removeNode(NODE_ID)).rejects.toMatchObject({ code: "unreachable" });
        expect(db.vpnNode.delete).not.toHaveBeenCalled();
        await service.removeNode(NODE_ID, true);
        expect(db.vpnNode.delete).toHaveBeenCalledOnce();
    });
});

describe("the browser route on a node's edge", () => {
    const { publicKey } = node;
    const FILE = "polaris-vpn-proxy.yml";
    const change = { name: "n", endpoint: "vpn.example.test", port: 51820, exit: "direct" as const };

    /** A machine answering the setup, with an edge or without one. */
    function machine(edge: boolean) {
        const sent: string[] = [];
        script.run.mockImplementation(async (_client, _command, options) => {
            const input = options.input as string;
            sent.push(input);
            if (input.includes("public-key=")) options.onStdout(Buffer.from(`public-key=${publicKey}\n`));
            if (edge && input.includes("polaris-traefik")) options.onStdout(Buffer.from("edge=ready\n"));
            return { code: 0 };
        });
        return sent;
    }
    const proxyHost = () => db.vpnNode.update.mock.calls.at(-1)?.[0].data.proxyHost;

    beforeEach(() => {
        db.vpnNode.update.mockImplementation(async ({ data }) => ({ ...node, ...data }));
    });

    it("is published on a machine with an edge", async () => {
        const sent = machine(true);
        await service.updateNode(NODE_ID, change);
        expect(proxyHost()).toBe("vpn.example.test");
        expect(sent.some((one) => one.includes("mv -f") && one.includes(FILE))).toBe(true);
    });

    it("is not claimed on a machine with no edge", async () => {
        const sent = machine(false);
        await service.updateNode(NODE_ID, change);
        expect(proxyHost()).toBeNull();
        expect(sent.at(-1)).toContain(`rm -f`);
        expect(sent.at(-1)).toContain(FILE);
    });

    it("leaves a name another site answers on alone, tunnel included", async () => {
        script.taken.mockResolvedValue(true);
        const sent = machine(true);
        await service.updateNode(NODE_ID, change);
        expect(proxyHost()).toBeNull();
        expect(sent.some((one) => one.includes("mv -f") && one.includes(FILE))).toBe(false);
    });

    it("is taken back when the endpoint becomes an address", async () => {
        const sent = machine(true);
        await service.updateNode(NODE_ID, { ...change, endpoint: "198.51.100.7" });
        expect(proxyHost()).toBeNull();
        expect(sent.at(-1)).toContain(FILE);
    });

    it("goes with the node", async () => {
        const sent = machine(true);
        await service.removeNode(NODE_ID);
        expect(sent[0]).toContain(`rm -f`);
        expect(sent[0]).toContain(FILE);
        expect(sent[0]).toContain("polaris-vpn-proxy.service");
    });
});

describe("writing a node's peer list", () => {
    it("reads the list inside the node's lock", async () => {
        const order: string[] = [];
        tx.$executeRaw.mockImplementationOnce(async () => {
            order.push("lock");
            return 1;
        });
        db.vpnPeer.findMany.mockImplementation(async ({ select }) => {
            if (select.user) order.push("read");
            return [];
        });
        script.run.mockImplementation(async () => {
            order.push("write");
            return { code: 0 };
        });
        await service.connectClient(admin, device);
        expect(order).toEqual(["lock", "read", "write"]);
    });
});

describe("who may change a node", () => {
    it("asks for a node on a machine of theirs", async () => {
        db.vpnNode.findFirst.mockResolvedValue(null);
        expect(await service.ownsNode(NODE_ID, "other")).toBe(false);
        expect(db.vpnNode.findFirst.mock.calls[0]?.[0].where).toEqual({
            id: NODE_ID,
            host: { ownerId: "other" }
        });
    });
});

describe("a machine leaving Polaris", () => {
    it("says when its node could not be taken down", async () => {
        script.run.mockResolvedValue({ code: 1 });
        expect(await service.removeNodeOn("host")).toBe(false);
        expect(db.vpnNode.delete).not.toHaveBeenCalled();
    });

    it("has nothing to do without a node", async () => {
        db.vpnNode.findUnique.mockResolvedValue(null);
        expect(await service.removeNodeOn("host")).toBe(true);
    });
});

describe("the proxy's counters", () => {
    it("skips somebody who no longer exists", async () => {
        const known = "11111111-1111-4111-8111-111111111112";
        const gone = "11111111-1111-4111-8111-111111111113";
        db.vpnNode.findMany.mockResolvedValue([node]);
        db.vpnAccess.findMany = vi.fn(async () => []);
        db.vpnAccess.updateMany = vi.fn(async () => undefined);
        db.vpnPeer.findMany.mockResolvedValue([]);
        db.user.findMany.mockResolvedValue([{ id: known }]);
        db.vpnProxyUsage.findUnique.mockResolvedValue(null);
        script.run.mockImplementation(async (_client, _command, options) => {
            if ((options.input as string).includes("/usage")) {
                options.onStdout(Buffer.from(`${known} 5\n${gone} 9\n`));
            }
            return { code: 0 };
        });
        await service.runVpnPass();
        expect(db.vpnProxyUsage.upsert).toHaveBeenCalledOnce();
        expect(db.vpnProxyUsage.upsert.mock.calls[0]?.[0].create.userId).toBe(known);
    });
});

describe("the peers a node lets in", () => {
    it("drops somebody who lost access and keeps an administrator", async () => {
        const key = `${"B".repeat(42)}A=`;
        const gone = `${"C".repeat(42)}A=`;
        db.vpnPeer.findMany.mockImplementation(async ({ select }) =>
            select.user
                ? [
                      { publicKey: key, hostIndex: 2, user: { isAdmin: true, vpnAccess: null } },
                      {
                          publicKey: gone,
                          hostIndex: 3,
                          user: {
                              isAdmin: false,
                              vpnAccess: {
                                  nodes: [],
                                  deviceLimit: 5,
                                  dataLimitGb: null,
                                  expiresAt: null,
                                  suspended: true,
                                  usedBytes: 0n
                              }
                          }
                      }
                  ]
                : []
        );
        await service.connectClient(admin, device);
        const sent = script.run.mock.calls[0]?.[2].input as string;
        expect(sent).toContain(key);
        expect(sent).not.toContain(gone);
    });
});

describe("an app connecting", () => {
    const key = `${"B".repeat(42)}E=`;
    const input = { nodeId: NODE_ID, name: "Laptop", publicKey: key };

    it("registers only the key it was sent", async () => {
        script.setting.mockResolvedValue("true");
        db.vpnPeer.findUnique.mockResolvedValue(null);
        const made = await service.connectClient(person, input);
        expect(made.address).toMatch(/^10\./);
        expect(db.vpnPeer.create.mock.calls.at(-1)?.[0].data.publicKey).toBe(key);
    });

    it("gives the same device back and spends no slot reconnecting", async () => {
        script.setting.mockResolvedValue("true");
        db.vpnPeer.count.mockResolvedValue(5);
        db.vpnPeer.findUnique.mockResolvedValue({ id: "peer", userId: person.id, hostIndex: 7, nodeId: NODE_ID });
        expect((await service.connectClient(person, input)).deviceId).toBe("peer");
        expect(db.vpnPeer.create).not.toHaveBeenCalled();
    });

    it("will not hand over somebody else's device", async () => {
        script.setting.mockResolvedValue("true");
        db.vpnPeer.findUnique.mockResolvedValue({ id: "peer", userId: "other", hostIndex: 7, nodeId: NODE_ID });
        await expect(service.connectClient(person, input)).rejects.toMatchObject({ code: "notFound" });
    });

    it("refuses something that is not a key", async () => {
        await expect(service.connectClient(admin, { ...input, publicKey: "x\nrm -rf" })).rejects.toMatchObject({ code: "notFound" });
    });
});
