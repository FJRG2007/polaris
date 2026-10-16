/**
 * Pausing and removing a tunnel across two servers when one of them does not
 * answer: what is cleaned up anyway, what is kept, and what the refusal names.
 * The row only goes once nothing of the tunnel is left anywhere.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const MASTER = Buffer.alloc(32, 7).toString("base64");
const ID = "0190a8c4-0000-7000-8000-000000000001";

interface FakePorts {
    composeUp: ReturnType<typeof vi.fn>;
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
    deleted: 0,
    others: [] as Record<string, unknown>[],
    hostnameTaken: false,
    conflicts: 0,
    created: [] as Record<string, unknown>[],
    edge: { traefik: true, pushable: true, error: null as string | null },
    prepared: 0,
    owned: { target: true as boolean, app: true as boolean }
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: MASTER }) }));
vi.mock("@/lib/domain-service", () => ({ getPublicIp: vi.fn(async () => "203.0.113.7") }));
vi.mock("@/lib/deploy-service", () => ({ containerPortOf: () => 3000 }));
vi.mock("@/lib/traefik-dynamic", () => ({ writeDynamicFile: vi.fn(async () => undefined) }));
vi.mock("@/lib/app-edge", () => ({ edgeHostnameTaken: vi.fn(async () => state.hostnameTaken) }));
vi.mock("@/lib/deploy/server-edge", () => ({
    readServerEdge: vi.fn(async () => state.edge),
    prepareServerEdge: vi.fn(async () => {
        state.prepared += 1;
    }),
    withSetupLock: vi.fn(async (_host: string, run: () => Promise<void>) => run())
}));
vi.mock("@/lib/deploy/service-networks", () => ({
    connectorNetworks: vi.fn(async () => ["polaris-proxy"])
}));
vi.mock("@/lib/host-service", () => ({
    getHostConnection: vi.fn(async () => ({
        address: "198.51.100.1",
        port: 22,
        username: "x",
        auth: {},
        hostKey: null
    }))
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
interface FindArgs {
    where?: { id?: string | { in: string[] } };
    select?: Record<string, unknown>;
}

function rowsOf(): Record<string, unknown>[] {
    return [...(state.row ? [state.row] : []), ...state.others];
}

function rowById(id: unknown): Record<string, unknown> | undefined {
    return rowsOf().find((row) => row.id === id);
}

vi.mock("@polaris/db", () => ({
    prisma: {
        deployTarget: {
            findFirst: vi.fn(async () => (state.owned.target ? { id: "t-public" } : null))
        },
        application: {
            findFirst: vi.fn(async () =>
                state.owned.app ? { id: "app-1", targetId: "t-home" } : null
            )
        },
        wireguardTunnel: {
            findFirst: vi.fn(async ({ where }: FindArgs) => {
                const row = rowById(where?.id);
                return row ? { ...row } : null;
            }),
            findUnique: vi.fn(async () => null),
            findMany: vi.fn(async ({ where, select }: FindArgs) => {
                if (select?.privateKeySealed) {
                    const ids = typeof where?.id === "object" ? where.id.in : null;
                    return rowsOf()
                        .filter((row) => !ids || ids.includes(row.id as string))
                        .map((row) => ({ ...row }));
                }
                if (select?.slot) return rowsOf().map((row) => ({ slot: row.slot }));
                if (select?.listenPort)
                    return rowsOf().map((row) => ({ listenPort: row.listenPort }));
                return rowsOf()
                    .filter((row) => !row.paused)
                    .map((row) => ({ id: row.id, hostname: row.hostname }));
            }),
            create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
                if (state.conflicts > 0) {
                    state.conflicts -= 1;
                    throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
                }
                state.created.push(data);
                state.row = {
                    ...data,
                    id: ID,
                    paused: false,
                    publicTarget: { ...PUBLIC, host: { address: "203.0.113.7" } },
                    application: APPLICATION
                };
                return { id: ID };
            }),
            update: vi.fn(
                async ({
                    where,
                    data
                }: {
                    where: { id: string };
                    data: Record<string, unknown>;
                }) => {
                    const row = rowById(where.id);
                    if (row) Object.assign(row, data);
                    return row;
                }
            ),
            updateMany: vi.fn(
                async ({
                    where,
                    data
                }: {
                    where: { id: string };
                    data: Record<string, unknown>;
                }) => {
                    const row = rowById(where.id);
                    if (row) Object.assign(row, data);
                    return { count: row ? 1 : 0 };
                }
            ),
            deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => {
                state.deleted += 1;
                if (state.row?.id === where.id) state.row = null;
                state.others = state.others.filter((row) => row.id !== where.id);
                return { count: 1 };
            })
        }
    }
}));

const service = await import("@/lib/deploy/wireguard/tunnel-service");
const wg = await import("@/lib/deploy/wireguard/tunnel-config");

const PUBLIC = {
    id: "t-public",
    name: "edge-1",
    kind: "ssh",
    hostId: "h-1",
    runtime: "compose",
    proxyNetwork: "polaris-proxy"
};
const HOME = {
    id: "t-home",
    name: "home-box",
    kind: "ssh",
    hostId: "h-2",
    runtime: "compose",
    proxyNetwork: "polaris-proxy"
};
const APPLICATION = {
    id: "app-1",
    slug: "web",
    sourceType: "image",
    sourceConfig: {},
    domains: [],
    environment: { project: { slug: "shop" } },
    target: HOME
};

function fakePorts(): FakePorts {
    return {
        composeUp: vi.fn(async () => undefined),
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
        application: APPLICATION
    };
    state.unreachable = new Set();
    state.ports = new Map([
        [PUBLIC.id, fakePorts()],
        [HOME.id, fakePorts()]
    ]);
    state.pushed = [];
    state.pushFails = false;
    state.deleted = 0;
    state.others = [];
    state.hostnameTaken = false;
    state.conflicts = 0;
    state.created = [];
    state.edge = { traefik: true, pushable: true, error: null };
    state.prepared = 0;
    state.owned = { target: true, app: true };
});

async function refusalOf(
    run: Promise<unknown>
): Promise<InstanceType<typeof service.TunnelRefusal>> {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const caught = await run.then(
        () => null,
        (error: unknown) => error
    );
    quiet.mockRestore();
    expect(caught).toBeInstanceOf(service.TunnelRefusal);
    return caught as InstanceType<typeof service.TunnelRefusal>;
}

describe("creating a tunnel", () => {
    const INPUT = { publicServerId: PUBLIC.id, serviceId: "app-1", hostname: " App.Example.com " };

    beforeEach(() => {
        state.row = null;
    });

    it("stores both keys sealed, starts both ends and puts the hostname on the public edge", async () => {
        expect(await service.createTunnel("owner", INPUT)).toEqual({ id: ID });
        const data = state.created[0] as {
            hostname: string;
            privateKeySealed: string;
            peerPrivateKeySealed: string;
        };
        expect(data.hostname).toBe("app.example.com");
        const publicKey = service.openKey(data.privateKeySealed);
        const natKey = service.openKey(data.peerPrivateKeySealed);
        expect(data.privateKeySealed).not.toContain(publicKey);

        const configOf = (spec: { services: { env: Record<string, string> }[] }): string =>
            Buffer.from(spec.services[0].env.WG_CONFIG, "base64").toString("utf8");
        const publicUp = configOf(state.ports.get(PUBLIC.id)?.composeUp.mock.calls[0][0]);
        const natUp = configOf(state.ports.get(HOME.id)?.composeUp.mock.calls[0][0]);
        expect(publicUp).toContain(publicKey);
        expect(publicUp).not.toContain(natKey);
        expect(natUp).toContain(natKey);
        expect(natUp).not.toContain(publicKey);
        expect(natUp).toContain("203.0.113.7:");
        expect(state.pushed.at(-1)?.yaml).toContain("app.example.com");
        expect(state.row?.paused).toBe(false);
    });

    it("sets up the edge on a public server that has none yet", async () => {
        state.edge = { traefik: false, pushable: false, error: null };
        await service.createTunnel("owner", INPUT);
        expect(state.prepared).toBe(1);
    });

    it("refuses before anything starts when the hostname is taken or the servers are not the caller's", async () => {
        state.hostnameTaken = true;
        expect((await refusalOf(service.createTunnel("owner", INPUT))).code).toBe("hostnameTaken");
        state.hostnameTaken = false;
        state.owned.target = false;
        expect((await refusalOf(service.createTunnel("owner", INPUT))).code).toBe("noServer");
        state.owned = { target: true, app: false };
        expect((await refusalOf(service.createTunnel("owner", INPUT))).code).toBe("noService");
        expect(
            (await refusalOf(service.createTunnel("owner", { ...INPUT, hostname: "nope" }))).code
        ).toBe("hostname");
        expect(state.created).toHaveLength(0);
        expect(state.ports.get(PUBLIC.id)?.composeUp).not.toHaveBeenCalled();
    });

    it("picks again when another create took the same slot or port", async () => {
        state.conflicts = 1;
        expect(await service.createTunnel("owner", INPUT)).toEqual({ id: ID });
        expect(state.created).toHaveLength(1);
    });

    it("takes back both ends and the row when an end does not start", async () => {
        state.ports.get(HOME.id)?.composeUp.mockRejectedValue(new Error("daemon said no"));
        await expect(service.createTunnel("owner", INPUT)).rejects.toThrow("daemon said no");
        expect(state.ports.get(PUBLIC.id)?.composeDown).toHaveBeenCalledWith(
            wg.endNames(ID, "public").project
        );
        expect(state.ports.get(HOME.id)?.composeDown).toHaveBeenCalledWith(
            wg.endNames(ID, "nat").project
        );
        expect(state.pushed.at(-1)?.yaml).not.toContain("app.example.com");
        expect(state.deleted).toBe(1);
    });

    it("refuses an edge that does not take Polaris routes, and leaves nothing behind", async () => {
        state.edge = { traefik: true, pushable: false, error: null };
        expect((await refusalOf(service.createTunnel("owner", INPUT))).code).toBe("edge");
        expect(state.ports.get(PUBLIC.id)?.composeUp).not.toHaveBeenCalled();
        expect(state.deleted).toBe(1);
    });
});

describe("resuming a tunnel", () => {
    it("starts both ends from the stored keys and routes the hostname again", async () => {
        (state.row as { paused: boolean }).paused = true;
        await service.setTunnelPaused("owner", ID, false);
        expect(state.ports.get(PUBLIC.id)?.composeUp).toHaveBeenCalled();
        expect(state.ports.get(HOME.id)?.composeUp).toHaveBeenCalled();
        expect(state.pushed.at(-1)?.yaml).toContain("app.example.com");
        expect(state.row?.paused).toBe(false);
    });

    it("stays paused, with what started taken down again, when an end does not start", async () => {
        (state.row as { paused: boolean }).paused = true;
        state.ports.get(HOME.id)?.composeUp.mockRejectedValue(new Error("daemon said no"));
        await expect(service.setTunnelPaused("owner", ID, false)).rejects.toThrow("daemon said no");
        expect(state.row?.paused).toBe(true);
        expect(state.ports.get(PUBLIC.id)?.composeDown).toHaveBeenCalledWith(
            wg.endNames(ID, "public").project
        );
        expect(state.pushed.at(-1)?.yaml).not.toContain("app.example.com");
    });
});

describe("a tunnel whose service or server is deleted", () => {
    it("is taken down on both ends and removed before the delete cascades it", async () => {
        const rows = await service.tunnelsWithin("owner", { applicationId: "app-1" });
        expect(rows.map((row) => row.id)).toEqual([ID]);
        expect(await service.retireTunnels("owner", rows)).toEqual([]);
        expect(state.ports.get(PUBLIC.id)?.composeDown).toHaveBeenCalledWith(
            wg.endNames(ID, "public").project
        );
        expect(state.ports.get(HOME.id)?.composeDown).toHaveBeenCalledWith(
            wg.endNames(ID, "nat").project
        );
        expect(state.pushed.at(-1)?.yaml).not.toContain("app.example.com");
        expect(state.deleted).toBe(1);
    });

    it("stays, paused, and names the server it is left on when one does not answer", async () => {
        const rows = await service.tunnelsWithin("owner", { hostId: HOME.hostId });
        state.unreachable.add(HOME.id);
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const left = await service.retireTunnels("owner", rows);
        quiet.mockRestore();
        expect(left).toEqual([{ hostname: "app.example.com", servers: "home-box" }]);
        expect(state.row?.paused).toBe(true);
        expect(state.deleted).toBe(0);
    });

    it("asks for the tunnels reaching the service, or with an end on the server", async () => {
        const { prisma } = await import("@polaris/db");
        const findMany = vi.mocked(prisma.wireguardTunnel.findMany);
        findMany.mockClear();
        await service.tunnelsWithin("owner", { hostId: "h-9" });
        await service.tunnelsWithin("owner", { applicationId: "app-9" });
        expect(findMany.mock.calls[0][0]?.where).toEqual({
            ownerId: "owner",
            OR: [
                { publicTarget: { hostId: "h-9" } },
                { application: { target: { hostId: "h-9" } } }
            ]
        });
        expect(findMany.mock.calls[1][0]?.where).toEqual({
            ownerId: "owner",
            applicationId: "app-9"
        });
    });

    it("starts again where its service moved, taking down the end on the old server", async () => {
        const before = (await service.tunnelsWithin("owner", { hostId: HOME.hostId }))[0];
        const moved = { ...HOME, id: "t-new", name: "new-box", hostId: "h-3" };
        state.ports.set(moved.id, fakePorts());
        (state.row as { application: unknown }).application = { ...APPLICATION, target: moved };
        expect(await service.moveTunnel("owner", before)).toEqual([]);
        expect(state.ports.get(HOME.id)?.composeDown).toHaveBeenCalledWith(
            wg.endNames(ID, "nat").project
        );
        expect(state.ports.get(moved.id)?.composeUp).toHaveBeenCalled();
        expect(state.ports.get(HOME.id)?.composeUp).not.toHaveBeenCalled();
        expect(state.row?.paused).toBe(false);
    });

    it("keeps a paused tunnel paused when its service moves", async () => {
        (state.row as { paused: boolean }).paused = true;
        const before = (await service.tunnelsWithin("owner", { hostId: HOME.hostId }))[0];
        await service.moveTunnel("owner", before);
        expect(state.ports.get(PUBLIC.id)?.composeUp).not.toHaveBeenCalled();
        expect(state.row?.paused).toBe(true);
    });
});

describe("removing a tunnel", () => {
    it("stops both ends, takes the hostname off the edge and deletes the row", async () => {
        await service.removeTunnel("owner", ID);
        expect(state.ports.get(PUBLIC.id)?.composeDown).toHaveBeenCalledWith(
            wg.endNames(ID, "public").project
        );
        expect(state.ports.get(HOME.id)?.composeDown).toHaveBeenCalledWith(
            wg.endNames(ID, "nat").project
        );
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
        expect((refusal as InstanceType<typeof service.TunnelRefusal>).params).toEqual({
            servers: "home-box"
        });
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
        expect((refusal as InstanceType<typeof service.TunnelRefusal>).params).toEqual({
            servers: "edge-1"
        });
        expect(state.deleted).toBe(0);
    });

    it("does not hold on to an end that never started", async () => {
        state.ports
            .get(HOME.id)
            ?.composeDown.mockRejectedValue(new Error("remote command exited with code 1"));
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
        expect((refusal as InstanceType<typeof service.TunnelRefusal>).params).toEqual({
            servers: "home-box"
        });
        expect(state.deleted).toBe(0);
    });

    it("never writes a private key into what it logs", async () => {
        state.unreachable.add(HOME.id);
        state.pushFails = true;
        const logged: unknown[] = [];
        const spy = vi
            .spyOn(console, "error")
            .mockImplementation((...args: unknown[]) => void logged.push(...args));
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
        const refusal = await service
            .setTunnelPaused("owner", ID, true)
            .catch((error: unknown) => error);
        quiet.mockRestore();
        expect((refusal as InstanceType<typeof service.TunnelRefusal>).code).toBe("leftoverPaused");
        expect((refusal as InstanceType<typeof service.TunnelRefusal>).params).toEqual({
            servers: "edge-1"
        });
        expect(state.row?.paused).toBe(true);
        expect(state.ports.get(HOME.id)?.composeDown).toHaveBeenCalledWith(
            wg.endNames(ID, "nat").project
        );
    });

    it("does nothing when the tunnel is already in that state", async () => {
        await service.setTunnelPaused("owner", ID, false);
        expect(state.ports.get(PUBLIC.id)?.composeDown).not.toHaveBeenCalled();
    });

    it("refuses a tunnel that is not the caller's", async () => {
        state.row = null;
        await expect(service.setTunnelPaused("owner", ID, true)).rejects.toMatchObject({
            code: "notFound"
        });
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
        expect(status).toEqual({
            health: "up",
            lastHandshake: 1760000000,
            rxBytes: 10,
            txBytes: 20
        });
        expect(state.ports.get(PUBLIC.id)?.runIn).toHaveBeenCalledWith(
            wg.endNames(ID, "public").helper,
            wg.statusCommand()
        );
    });

    it("reaches each server once for every tunnel it carries", async () => {
        const row = state.row as Record<string, unknown>;
        const second = {
            ...row,
            id: "0190a8c4-0000-7000-8000-000000000002",
            hostname: "two.example.com"
        };
        state.others = [second];
        const publicEnd = state.ports.get(PUBLIC.id);
        publicEnd?.runIn.mockImplementation(async (helper: string) => ({
            code: 0,
            output: [
                `public_key=${wg.keyToHex(row.peerPublicKey as string)}`,
                `last_handshake_time_sec=${helper === wg.endNames(ID, "public").helper ? 1760000000 : 0}`,
                "rx_bytes=1",
                "tx_bytes=2",
                ""
            ].join("\n")
        }));
        const { getPorts } = await import("@/lib/deploy/runtime");
        vi.mocked(getPorts).mockClear();
        const statuses = await service.readTunnelStatuses(
            "owner",
            [ID, second.id as string],
            1760000030 * 1000
        );
        expect(statuses[ID].health).toBe("up");
        expect(statuses[second.id as string].health).toBe("waiting");
        expect(vi.mocked(getPorts)).toHaveBeenCalledTimes(1);
        expect(publicEnd?.runIn).toHaveBeenCalledTimes(2);
        expect(publicEnd?.dispose).toHaveBeenCalledTimes(1);
    });

    it("reports a paused tunnel without asking any server, and leaves out ids that are not the owner's", async () => {
        (state.row as { paused: boolean }).paused = true;
        const statuses = await service.readTunnelStatuses("owner", [
            ID,
            "0190a8c4-0000-7000-8000-0000000000ee"
        ]);
        expect(statuses).toEqual({
            [ID]: { health: "paused", lastHandshake: 0, rxBytes: 0, txBytes: 0 }
        });
        expect(state.ports.get(PUBLIC.id)?.runIn).not.toHaveBeenCalled();
    });

    it("falls back to the end at home, and says unknown when neither answers", async () => {
        state.unreachable.add(PUBLIC.id);
        state.ports.get(HOME.id)?.runIn.mockResolvedValue({ code: 1, output: "" });
        expect((await service.readTunnelStatus("owner", ID)).health).toBe("unknown");
        expect(state.ports.get(HOME.id)?.runIn).toHaveBeenCalled();
        expect(state.ports.get(HOME.id)?.dispose).toHaveBeenCalled();
    });
});
