import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE_ID = "11111111-1111-4111-8111-111111111111";
const db = vi.hoisted(() => ({
    vpnAccess: { findUnique: vi.fn(), deleteMany: vi.fn(), upsert: vi.fn() },
    vpnNode: { findUnique: vi.fn(), findMany: vi.fn(), delete: vi.fn() },
    vpnPeer: { count: vi.fn(), create: vi.fn(), delete: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() }
}));
const script = vi.hoisted(() => ({ run: vi.fn(), setting: vi.fn() }));

vi.mock("@polaris/db", () => ({ prisma: db }));
vi.mock("@/lib/setting-store", () => ({ getSetting: script.setting, setSetting: vi.fn() }));
vi.mock("@/lib/deploy/server-edge", () => ({ edgeLauncher: () => "sh" }));
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

beforeEach(() => {
    vi.clearAllMocks();
    db.vpnAccess.findUnique.mockResolvedValue(null);
    db.vpnNode.findUnique.mockResolvedValue(node);
    db.vpnPeer.count.mockResolvedValue(0);
    db.vpnPeer.findMany.mockResolvedValue([]);
    db.vpnPeer.create.mockImplementation(async ({ data }) => ({ id: "peer", ...data }));
    script.setting.mockResolvedValue(null);
    script.run.mockResolvedValue({ code: 0 });
});

describe("who may add a device", () => {
    it("refuses somebody with no access while the VPN is not open", async () => {
        await expect(service.addDevice(person, { nodeId: NODE_ID, name: "Phone" })).rejects.toMatchObject(
            { code: "noAccess" }
        );
    });

    it("lets everybody in once it is open", async () => {
        script.setting.mockResolvedValue("true");
        const made = await service.addDevice(person, { nodeId: NODE_ID, name: "Phone" });
        expect(made.config).toContain("[Peer]");
    });

    it("stops at the person's device limit", async () => {
        db.vpnPeer.count.mockResolvedValue(5);
        await expect(service.addDevice(admin, { nodeId: NODE_ID, name: "Phone" })).rejects.toMatchObject({
            code: "deviceLimit"
        });
    });
});

describe("a device", () => {
    it("looks again when two take one address at once", async () => {
        db.vpnPeer.create.mockRejectedValueOnce(Object.assign(new Error("taken"), { code: "P2002" }));
        const made = await service.addDevice(admin, { nodeId: NODE_ID, name: "Phone" });
        expect(db.vpnPeer.create).toHaveBeenCalledTimes(2);
        expect(made.fileName).toBe("phone.conf");
    });

    it("hands the private key over and never stores it", async () => {
        const made = await service.addDevice(admin, { nodeId: NODE_ID, name: "Phone" });
        const key = /PrivateKey = (\S+)/.exec(made.config)?.[1];
        expect(key).toBeTruthy();
        expect(JSON.stringify(db.vpnPeer.create.mock.calls)).not.toContain(key);
    });

    it("is taken back when the node cannot be told", async () => {
        script.run.mockResolvedValue({ code: 1 });
        await expect(service.addDevice(admin, { nodeId: NODE_ID, name: "Phone" })).rejects.toMatchObject({
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
        await service.addDevice(admin, { nodeId: NODE_ID, name: "Phone" });
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
