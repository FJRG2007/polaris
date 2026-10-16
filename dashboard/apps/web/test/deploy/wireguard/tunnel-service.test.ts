/**
 * Pausing and removing a tunnel across two servers when one of them does not
 * answer: what is cleaned up anyway, what is kept, and what the refusal names.
 * The row only goes once nothing of the tunnel is left anywhere.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const MASTER = Buffer.alloc(32, 7).toString("base64");
const ID = "0190a8c4-0000-7000-8000-000000000001";

interface FakePorts {
    composeDown: ReturnType<typeof vi.fn>;
    inspect: ReturnType<typeof vi.fn>;
    runIn: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted(() => ({
    row: null as Record<string, unknown> | null,
    unreachable: new Set<string>(),
    ports: new Map<string, FakePorts>(),
    pushed: [] as { file: string; yaml: string }[],
    pushFails: false,
    deleted: 0
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: MASTER }) }));
vi.mock("@/lib/domain-service", () => ({ getPublicIp: vi.fn(async () => "203.0.113.7") }));
vi.mock("@/lib/deploy-service", () => ({ containerPortOf: () => 3000 }));
vi.mock("@/lib/traefik-dynamic", () => ({ writeDynamicFile: vi.fn(async () => undefined) }));
vi.mock("@/lib/deploy/service-networks", () => ({ connectorNetworks: vi.fn(async () => ["polaris-proxy"]) }));
vi.mock("@/lib/host-service", () => ({
    getHostConnection: vi.fn(async () => ({ address: "198.51.100.1", port: 22, username: "x", auth: {}, hostKey: null }))
}));
vi.mock("@/lib/deploy/router-remote", () => ({
    RemoteRouter: class {
        public async pushFile(file: string, yaml: string): Promise<void> {
            if (state.pushFails) throw new Error("ssh: connect timed out");
            state.pushed.push({ file, yaml });
        }
    }
}));
vi.mock("@/lib/deploy/runtime", () => ({
    getPorts: vi.fn(async (target: { id: string }) => {
        if (state.unreachable.has(target.id)) throw new Error("ssh: connect timed out");
        const ports = state.ports.get(target.id);
        if (!ports) throw new Error(`no ports for ${target.id}`);
        return ports;
    })
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        wireguardTunnel: {
            findFirst: vi.fn(async () => (state.row ? { ...state.row } : null)),
            findMany: vi.fn(async () =>
                state.row && !state.row.paused ? [{ id: state.row.id, hostname: state.row.hostname }] : []
            ),
            update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
                if (state.row) Object.assign(state.row, data);
                return state.row;
            }),
            deleteMany: vi.fn(async () => {
                state.deleted += 1;
                state.row = null;
                return { count: 1 };
            })
        }
    }
}));

const service = await import("@/lib/deploy/wireguard/tunnel-service");
const wg = await import("@/lib/deploy/wireguard/tunnel-config");

const PUBLIC = { id: "t-public", name: "edge-1", kind: "ssh", hostId: "h-1", runtime: "compose", proxyNetwork: "polaris-proxy" };
const HOME = { id: "t-home", name: "home-box", kind: "ssh", hostId: "h-2", runtime: "compose", proxyNetwork: "polaris-proxy" };

function fakePorts(): FakePorts {
    return {
        composeDown: vi.fn(async () => undefined),
        inspect: vi.fn(async () => {
            throw new Error("inspect x failed (404)");
        }),
        runIn: vi.fn(),
        dispose: vi.fn(async () => undefined)
    };
}

beforeEach(() => {
    const pub = wg.generateKeyPair();
    const nat = wg.generateKeyPair();
    state.row = {
        id: ID,
        hostname: "app.example.com",
        listenPort: 51821,
        slot: 0,
        paused: false,
        publicKey: pub.publicKey,
        privateKeySealed: service.sealKey(pub.privateKey),
        peerPublicKey: nat.publicKey,
        peerPrivateKeySealed: service.sealKey(nat.privateKey),
        publicTarget: { ...PUBLIC, host: { address: "203.0.113.7" } },
        application: {
            id: "app-1",
            slug: "web",
            sourceType: "image",
            sourceConfig: {},
            domains: [],
            environment: { project: { slug: "shop" } },
            target: HOME
        }
    };
    state.unreachable = new Set();
    state.ports = new Map([
        [PUBLIC.id, fakePorts()],
        [HOME.id, fakePorts()]
    ]);
    state.pushed = [];
    state.pushFails = false;
    state.deleted = 0;
});

describe("removing a tunnel", () => {
    it("stops both ends, takes the hostname off the edge and deletes the row", async () => {
        await service.removeTunnel("owner", ID);
        expect(state.ports.get(PUBLIC.id)?.composeDown).toHaveBeenCalledWith(wg.endNames(ID, "public").project);
        expect(state.ports.get(HOME.id)?.composeDown).toHaveBeenCalledWith(wg.endNames(ID, "nat").project);
        expect(state.pushed).toHaveLength(1);
        expect(state.pushed[0].file).toBe(wg.TUNNEL_ROUTE_FILE);
        expect(state.pushed[0].yaml).not.toContain("app.example.com");
        expect(state.deleted).toBe(1);
    });

    it("cleans the server that answers, keeps the row paused, and names the one that did not", async () => {
        state.unreachable.add(HOME.id);
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const refusal = await service.removeTunnel("owner", ID).catch((error: unknown) => error);
        quiet.mockRestore();
        expect(refusal).toBeInstanceOf(service.TunnelRefusal);
        expect((refusal as InstanceType<typeof service.TunnelRefusal>).code).toBe("leftover");
        expect((refusal as InstanceType<typeof service.TunnelRefusal>).params).toEqual({ servers: "home-box" });
        expect(state.ports.get(PUBLIC.id)?.composeDown).toHaveBeenCalled();
        expect(state.pushed[0].yaml).not.toContain("app.example.com");
        expect(state.deleted).toBe(0);
        expect(state.row?.paused).toBe(true);

        // Once the server is back, removing it again finishes the job.
        state.unreachable.clear();
        await service.removeTunnel("owner", ID);
        expect(state.deleted).toBe(1);
    });

    it("counts an edge it could not rewrite as left behind", async () => {
        state.pushFails = true;
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const refusal = await service.removeTunnel("owner", ID).catch((error: unknown) => error);
        quiet.mockRestore();
        expect((refusal as InstanceType<typeof service.TunnelRefusal>).params).toEqual({ servers: "edge-1" });
        expect(state.deleted).toBe(0);
    });

    it("does not hold on to an end that never started", async () => {
        state.ports.get(HOME.id)?.composeDown.mockRejectedValue(new Error("remote command exited with code 1"));
        await service.removeTunnel("owner", ID);
        expect(state.deleted).toBe(1);
    });

    it("holds on to an end whose containers are still there", async () => {
        const home = state.ports.get(HOME.id);
        home?.composeDown.mockRejectedValue(new Error("remote command exited with code 1"));
        home?.inspect.mockResolvedValue({ State: { Running: true } });
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const refusal = await service.removeTunnel("owner", ID).catch((error: unknown) => error);
        quiet.mockRestore();
        expect((refusal as InstanceType<typeof service.TunnelRefusal>).params).toEqual({ servers: "home-box" });
        expect(state.deleted).toBe(0);
    });

    it("never writes a private key into what it logs", async () => {
        state.unreachable.add(HOME.id);
        state.pushFails = true;
        const logged: unknown[] = [];
        const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(...args));
        await service.removeTunnel("owner", ID).catch(() => undefined);
        spy.mockRestore();
        const text = logged.map((one) => String(one)).join("\n");
        const row = state.row as { privateKeySealed: string; peerPrivateKeySealed: string };
        expect(text).not.toContain(service.openKey(row.privateKeySealed));
        expect(text).not.toContain(service.openKey(row.peerPrivateKeySealed));
    });
});

describe("pausing a tunnel", () => {
    it("records the pause and says which server still runs its end", async () => {
        state.unreachable.add(PUBLIC.id);
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const refusal = await service.setTunnelPaused("owner", ID, true).catch((error: unknown) => error);
        quiet.mockRestore();
        expect((refusal as InstanceType<typeof service.TunnelRefusal>).params).toEqual({ servers: "edge-1" });
        expect(state.row?.paused).toBe(true);
        expect(state.ports.get(HOME.id)?.composeDown).toHaveBeenCalledWith(wg.endNames(ID, "nat").project);
    });

    it("does nothing when the tunnel is already in that state", async () => {
        await service.setTunnelPaused("owner", ID, false);
        expect(state.ports.get(PUBLIC.id)?.composeDown).not.toHaveBeenCalled();
    });

    it("refuses a tunnel that is not the caller's", async () => {
        state.row = null;
        await expect(service.setTunnelPaused("owner", ID, true)).rejects.toMatchObject({ code: "notFound" });
        await expect(service.removeTunnel("owner", ID)).rejects.toMatchObject({ code: "notFound" });
    });
});

describe("reading a tunnel's state", () => {
    it("reads the handshake from the public end, which redacts its own key", async () => {
        const row = state.row as { peerPublicKey: string };
        state.ports.get(PUBLIC.id)?.runIn.mockResolvedValue({
            code: 0,
            output: [
                "private_key=REDACTED",
                "listen_port=51821",
                `public_key=${wg.keyToHex(row.peerPublicKey)}`,
                "endpoint=198.51.100.4:40211",
                "last_handshake_time_sec=1760000000",
                "rx_bytes=10",
                "tx_bytes=20",
                ""
            ].join("\n")
        });
        const status = await service.readTunnelStatus("owner", ID, 1760000030 * 1000);
        expect(status).toEqual({ health: "up", lastHandshake: 1760000000, rxBytes: 10, txBytes: 20 });
        expect(state.ports.get(PUBLIC.id)?.runIn).toHaveBeenCalledWith(wg.endNames(ID, "public").helper, wg.statusCommand());
    });

    it("falls back to the end at home, and says unknown when neither answers", async () => {
        state.unreachable.add(PUBLIC.id);
        state.ports.get(HOME.id)?.runIn.mockResolvedValue({ code: 1, output: "" });
        expect((await service.readTunnelStatus("owner", ID)).health).toBe("unknown");
        expect(state.ports.get(HOME.id)?.runIn).toHaveBeenCalled();
        expect(state.ports.get(HOME.id)?.dispose).toHaveBeenCalled();
    });
});
