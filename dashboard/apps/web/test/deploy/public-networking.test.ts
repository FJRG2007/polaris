/**
 * A service's public networking, past adding a domain: a port per domain, a
 * generated name renamed in place, TCP proxies on ports nobody else holds, the
 * ports a container listens on, and what a custom domain's DNS says.
 *
 * The database, the zones, DNS and the container runtime are replaced; what is
 * asserted is what this makes of their answers and what it writes back.
 */

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    domainFindFirst: vi.fn(),
    domainFindUnique: vi.fn(),
    domainUpdate: vi.fn(),
    appFindFirst: vi.fn(),
    appFindMany: vi.fn(),
    appUpdate: vi.fn(),
    appFindUniqueOrThrow: vi.fn(),
    appUpdateMany: vi.fn(),
    deploymentCount: vi.fn(),
    connect: vi.fn(),
    managedFindMany: vi.fn(),
    syncAppRoutes: vi.fn(),
    checkZoneSubdomain: vi.fn(),
    listDeployZones: vi.fn(),
    runIn: vi.fn(),
    resolve4: vi.fn(),
    resolve6: vi.fn(),
    resolveCname: vi.fn(),
    resolveSoa: vi.fn()
}));

vi.mock("@polaris/db", () => {
    const prisma = {
        domain: {
            findFirst: mocks.domainFindFirst,
            findUnique: mocks.domainFindUnique,
            update: mocks.domainUpdate
        },
        application: {
            findFirst: mocks.appFindFirst,
            findMany: mocks.appFindMany,
            update: mocks.appUpdate,
            findUniqueOrThrow: mocks.appFindUniqueOrThrow,
            updateMany: mocks.appUpdateMany
        },
        deployment: { count: mocks.deploymentCount },
        managedCertificate: { findMany: mocks.managedFindMany },
        $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(prisma)
    };
    class PrismaClientKnownRequestError extends Error {
        public constructor(public readonly code: string) {
            super(code);
        }
    }
    return {
        prisma,
        Prisma: {
            TransactionIsolationLevel: { Serializable: "Serializable" },
            PrismaClientKnownRequestError
        }
    };
});
vi.mock("@/lib/deploy-service", () => ({
    syncAppRoutes: mocks.syncAppRoutes,
    checkZoneSubdomain: mocks.checkZoneSubdomain,
    // The real rule, small enough to restate: the pin, then the detected port,
    // then the first domain's, then the source default.
    containerPortOf: (app: {
        sourceType: string;
        sourceConfig: string;
        domains?: { targetPort: number }[];
    }) => {
        const source = JSON.parse(app.sourceConfig) as { port?: number; detectedPort?: number };
        return (
            source.port ??
            source.detectedPort ??
            app.domains?.[0]?.targetPort ??
            (app.sourceType === "image" ? 80 : 3000)
        );
    }
}));
vi.mock("@/lib/domain-zones", () => ({ listDeployZones: mocks.listDeployZones }));
vi.mock("@/lib/network-service", () => ({ detectPublicIp: async () => "203.0.113.7" }));
vi.mock("@/lib/domain-service", () => ({ getPublicIp: async () => "10.0.1.10" }));
vi.mock("@/lib/deploy/runtime", () => ({
    getPorts: async () => ({ runIn: mocks.runIn, dispose: async () => undefined })
}));
vi.mock("@/lib/deploy/releases", () => ({
    currentReleaseRef: async () => ({ name: "polaris-abc-web" })
}));
vi.mock("node:dns/promises", () => ({
    resolve4: mocks.resolve4,
    resolve6: mocks.resolve6,
    resolveCname: mocks.resolveCname,
    resolveSoa: mocks.resolveSoa
}));
vi.mock("node:tls", () => ({
    // No certificate to read from here: the handshake fails at once.
    connect: (options: unknown) => {
        mocks.connect(options);
        const socket = Object.assign(new EventEmitter(), {
            setTimeout: () => undefined,
            destroy: () => undefined
        });
        queueMicrotask(() => socket.emit("error", new Error("refused")));
        return socket;
    }
}));

const publicNet = await import("@/lib/deploy/public-networking");

const OWNER = "owner-1";

function app(overrides: Record<string, unknown> = {}) {
    return {
        id: "0190aaaa-0000-7000-8000-000000000001",
        slug: "web",
        sourceType: "nixpacks",
        sourceConfig: JSON.stringify({ port: 3000 }),
        currentDeploymentId: "rel-1",
        targetId: "target-1",
        target: {
            id: "target-1",
            kind: "local",
            hostId: null,
            runtime: "compose",
            proxyNetwork: "polaris-proxy",
            host: null
        },
        environment: { project: { slug: "shop", ownerId: OWNER, orgId: null } },
        domains: [],
        ...overrides
    };
}

beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.syncAppRoutes.mockResolvedValue(undefined);
    mocks.resolve4.mockResolvedValue([]);
    mocks.resolve6.mockResolvedValue([]);
    mocks.resolveCname.mockResolvedValue([]);
    mocks.resolveSoa.mockRejectedValue(new Error("ENODATA"));
    mocks.managedFindMany.mockResolvedValue([]);
    mocks.deploymentCount.mockResolvedValue(0);
    mocks.appUpdateMany.mockResolvedValue({ count: 1 });
    mocks.appFindUniqueOrThrow.mockImplementation(async () => ({
        sourceConfig: (await mocks.appFindFirst())?.sourceConfig ?? "{}"
    }));
});

function written(call = 0): unknown {
    return JSON.parse(mocks.appUpdateMany.mock.calls[call]?.[0].data.sourceConfig as string);
}

function pinnable(
    overrides: Record<string, unknown> = {},
    application: Record<string, unknown> = {}
) {
    return {
        id: "d1",
        deploymentId: null,
        servedBy: "server",
        application: {
            sourceType: "nixpacks",
            sourceConfig: '{"port":3000}',
            currentDeploymentId: "rel-1",
            target: { kind: "local", hostId: null },
            ...application
        },
        ...overrides
    };
}

describe("a port per domain", () => {
    it("pins a port other than the service's own, and republishes the routes", async () => {
        mocks.domainFindFirst.mockResolvedValue(pinnable());
        await publicNet.setDomainPort("d1", OWNER, 9000);
        expect(mocks.domainUpdate).toHaveBeenCalledWith({
            where: { id: "d1" },
            data: { targetPort: 9000, portPinned: true }
        });
        expect(mocks.syncAppRoutes).toHaveBeenCalledTimes(1);
    });

    it("unpins a domain set back to the service's port, so it follows the service again", async () => {
        mocks.domainFindFirst.mockResolvedValue(pinnable());
        await publicNet.setDomainPort("d1", OWNER, 3000);
        expect(mocks.domainUpdate.mock.calls[0]?.[0].data).toEqual({
            targetPort: 3000,
            portPinned: false
        });
    });

    it("refuses a port the edge would not dial: another server's domain fronted here, one release's, a kept release's", async () => {
        mocks.domainFindFirst.mockResolvedValue(
            pinnable({ servedBy: "polaris" }, { target: { kind: "server", hostId: "host-1" } })
        );
        await expect(publicNet.setDomainPort("d1", OWNER, 9000)).rejects.toMatchObject({
            code: "portFixed"
        });
        mocks.domainFindFirst.mockResolvedValue(pinnable({ deploymentId: "rel-0" }));
        await expect(publicNet.setDomainPort("d1", OWNER, 9000)).rejects.toMatchObject({
            code: "portFixed"
        });
        mocks.domainFindFirst.mockResolvedValue(pinnable());
        mocks.deploymentCount.mockResolvedValue(1);
        await expect(publicNet.setDomainPort("d1", OWNER, 9000)).rejects.toMatchObject({
            code: "portFixed"
        });
        expect(mocks.domainUpdate).not.toHaveBeenCalled();
        await publicNet.setDomainPort("d1", OWNER, 3000);
        expect(mocks.domainUpdate.mock.calls[0]?.[0].data).toEqual({
            targetPort: 3000,
            portPinned: false
        });
    });

    it("pins on a server whose own edge serves the domain", async () => {
        mocks.domainFindFirst.mockResolvedValue(
            pinnable({}, { target: { kind: "server", hostId: "host-1" } })
        );
        await publicNet.setDomainPort("d1", OWNER, 9000);
        expect(mocks.domainUpdate.mock.calls[0]?.[0].data).toEqual({
            targetPort: 9000,
            portPinned: true
        });
    });

    it("refuses a port out of range, and a domain of another owner", async () => {
        await expect(publicNet.setDomainPort("d1", OWNER, 70_000)).rejects.toMatchObject({
            code: "badPort"
        });
        mocks.domainFindFirst.mockResolvedValue(null);
        await expect(publicNet.setDomainPort("d1", OWNER, 8080)).rejects.toMatchObject({
            code: "notFound"
        });
        expect(mocks.domainUpdate).not.toHaveBeenCalled();
    });
});

describe("renaming a generated name", () => {
    const zone = { label: "plr", host: "plr.example.com", primary: true, kind: "zone" };

    beforeEach(() => {
        mocks.listDeployZones.mockResolvedValue([zone]);
        mocks.domainFindFirst.mockResolvedValue({
            hostname: "web.plr.example.com",
            kind: "auto",
            applicationId: "app-1",
            application: { environment: { project: { ownerId: OWNER, orgId: null } } }
        });
        mocks.domainFindUnique.mockResolvedValue({ hostname: "web.plr.example.com" });
    });

    it("moves it to the new subdomain in the same zone", async () => {
        mocks.checkZoneSubdomain.mockResolvedValue({
            subdomain: "shop",
            hostname: "shop.plr.example.com",
            available: true
        });
        expect(await publicNet.renameDomain("d1", OWNER, "shop")).toBe("shop.plr.example.com");
        expect(mocks.checkZoneSubdomain).toHaveBeenCalledWith("app-1", OWNER, {
            zoneLabel: "plr",
            subdomain: "shop"
        });
        expect(mocks.domainUpdate.mock.calls[0]?.[0].data.hostname).toBe("shop.plr.example.com");
        expect(mocks.syncAppRoutes).toHaveBeenCalled();
    });

    it("refuses a name already taken, and writes nothing", async () => {
        mocks.checkZoneSubdomain.mockResolvedValue({
            subdomain: "api",
            hostname: "api.plr.example.com",
            available: false
        });
        await expect(publicNet.renameDomain("d1", OWNER, "api")).rejects.toMatchObject({
            code: "taken"
        });
        expect(mocks.domainUpdate).not.toHaveBeenCalled();
    });

    it("refuses a custom domain: its name is somebody's DNS, not a zone's", async () => {
        mocks.domainFindFirst.mockResolvedValue({
            hostname: "shop.example.org",
            kind: "custom",
            applicationId: "app-1",
            application: { environment: { project: { ownerId: OWNER, orgId: null } } }
        });
        await expect(publicNet.renameDomain("d1", OWNER, "x")).rejects.toMatchObject({
            code: "notRenameable"
        });
    });
});

describe("TCP proxies", () => {
    it("takes a public port no service publishes", async () => {
        mocks.appFindFirst.mockResolvedValue(app());
        mocks.appFindMany.mockResolvedValue([
            { sourceConfig: JSON.stringify({ hostPort: 25565 }) },
            { sourceConfig: JSON.stringify({ tcpProxies: [{ container: 5432, host: 40000 }] }) }
        ]);
        const proxy = await publicNet.addTcpProxy(app().id, OWNER, 5432);
        expect(proxy.container).toBe(5432);
        expect(proxy.host).toBeGreaterThanOrEqual(40000);
        expect(proxy.host).not.toBe(40000);
        expect(mocks.appFindMany).toHaveBeenCalledWith({ select: { sourceConfig: true } });
        expect(written()).toEqual({ port: 3000, tcpProxies: [proxy] });
        expect(mocks.appUpdateMany.mock.calls[0]?.[0].where).toEqual({
            id: app().id,
            sourceConfig: JSON.stringify({ port: 3000 })
        });
    });

    it("starts over on what a concurrent write left, so neither is lost", async () => {
        mocks.appFindFirst.mockResolvedValue(app());
        mocks.appFindMany.mockResolvedValue([]);
        const raced = JSON.stringify({
            port: 3000,
            tcpProxies: [{ container: 6379, host: 41234 }]
        });
        mocks.appFindUniqueOrThrow
            .mockResolvedValueOnce({ sourceConfig: JSON.stringify({ port: 3000 }) })
            .mockResolvedValueOnce({ sourceConfig: raced });
        mocks.appUpdateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
        const proxy = await publicNet.addTcpProxy(app().id, OWNER, 5432);
        expect(mocks.appUpdateMany).toHaveBeenCalledTimes(2);
        expect(written(1)).toEqual({
            port: 3000,
            tcpProxies: [{ container: 6379, host: 41234 }, proxy]
        });
    });

    it("returns the proxy a port already has rather than opening a second", async () => {
        mocks.appFindFirst.mockResolvedValue(
            app({
                sourceConfig: JSON.stringify({ tcpProxies: [{ container: 6379, host: 41234 }] })
            })
        );
        expect(await publicNet.addTcpProxy(app().id, OWNER, 6379)).toEqual({
            container: 6379,
            host: 41234
        });
        expect(mocks.appUpdateMany).not.toHaveBeenCalled();
    });

    it("holds a service to its limit", async () => {
        const many = Array.from({ length: publicNet.TCP_PROXY_LIMIT }, (_, index) => ({
            container: 1000 + index,
            host: 42000 + index
        }));
        mocks.appFindFirst.mockResolvedValue(
            app({ sourceConfig: JSON.stringify({ tcpProxies: many }) })
        );
        await expect(publicNet.addTcpProxy(app().id, OWNER, 9999)).rejects.toMatchObject({
            code: "proxyLimit"
        });
    });

    it("removes one and drops the key when none are left", async () => {
        mocks.appFindFirst.mockResolvedValue(
            app({
                sourceConfig: JSON.stringify({
                    port: 3000,
                    tcpProxies: [{ container: 6379, host: 41234 }]
                })
            })
        );
        await publicNet.removeTcpProxy(app().id, OWNER, 6379);
        expect(written()).toEqual({ port: 3000 });
    });
});

describe("the ports a service listens on", () => {
    it("reads them inside the serving container", async () => {
        mocks.appFindFirst.mockResolvedValue(app({ id: "0190aaaa-0000-7000-8000-0000000000a1" }));
        mocks.runIn.mockResolvedValue({
            code: 0,
            output: "   0: 00000000:0BB8 00000000:0000 0A 0\n   1: 00000000:2382 00000000:0000 0A 0"
        });
        const ports = await publicNet.serviceListeningPorts(
            "0190aaaa-0000-7000-8000-0000000000a1",
            OWNER
        );
        expect(ports).toEqual({ servicePort: 3000, ports: [3000, 9090], source: "runtime" });
        expect(mocks.runIn).toHaveBeenCalledWith("polaris-abc-web", [
            "cat",
            "/proc/net/tcp",
            "/proc/net/tcp6"
        ]);
    });

    it("falls back to the configured port for an image with nothing to read with", async () => {
        mocks.appFindFirst.mockResolvedValue(app({ id: "0190aaaa-0000-7000-8000-0000000000a2" }));
        mocks.runIn.mockRejectedValue(new Error("exec: cat: not found"));
        const ports = await publicNet.serviceListeningPorts(
            "0190aaaa-0000-7000-8000-0000000000a2",
            OWNER
        );
        expect(ports).toEqual({ servicePort: 3000, ports: [3000], source: "config" });
    });

    it("asks nothing of a service that was never deployed", async () => {
        mocks.appFindFirst.mockResolvedValue(
            app({ id: "0190aaaa-0000-7000-8000-0000000000a3", currentDeploymentId: null })
        );
        expect(
            (await publicNet.serviceListeningPorts("0190aaaa-0000-7000-8000-0000000000a3", OWNER))
                .source
        ).toBe("config");
        expect(mocks.runIn).not.toHaveBeenCalled();
    });
});

describe("what a custom domain's DNS says", () => {
    const custom = {
        id: "d-custom",
        hostname: "shop.example.org",
        kind: "custom",
        enabled: true,
        targetPort: 3000,
        portPinned: false,
        certResolver: "le",
        certPem: null
    };
    const generated = { ...custom, id: "d-auto", hostname: "web.plr.example.com", kind: "auto" };

    it("offers a CNAME to the service's generated name first, then the address", async () => {
        mocks.appFindFirst.mockResolvedValue(
            app({ id: "0190aaaa-0000-7000-8000-0000000000b1", domains: [generated, custom] })
        );
        const readings = await publicNet.domainReadings(
            "0190aaaa-0000-7000-8000-0000000000b1",
            OWNER
        );
        const reading = readings.find((entry) => entry.id === "d-custom");
        expect(reading?.dns?.verdict).toBe("missing");
        expect(reading?.dns?.records).toEqual([
            { type: "CNAME", name: "shop.example.org", value: "web.plr.example.com" },
            { type: "A", name: "shop.example.org", value: "203.0.113.7" }
        ]);
        // A generated name rides Polaris's own DNS and is not asked about.
        expect(readings.find((entry) => entry.id === "d-auto")?.dns).toBeNull();
        expect(reading?.cert?.verdict).toBe("unknown");
    });

    it("offers only an address at a zone apex, where a CNAME cannot live", async () => {
        mocks.resolveSoa.mockResolvedValue({ nsname: "ns.example.org" });
        mocks.resolve4.mockResolvedValue(["104.16.1.1"]);
        const apex = { ...custom, id: "d-apex", hostname: "example.org" };
        mocks.appFindFirst.mockResolvedValue(
            app({ id: "0190aaaa-0000-7000-8000-0000000000b2", domains: [generated, apex] })
        );
        const reading = (
            await publicNet.domainReadings("0190aaaa-0000-7000-8000-0000000000b2", OWNER)
        ).find((entry) => entry.id === "d-apex");
        expect(reading?.dns?.apex).toBe(true);
        expect(reading?.dns?.verdict).toBe("proxied");
        expect(reading?.dns?.records.map((record) => record.type)).toEqual(["A"]);
    });

    it("never opens a handshake to a name that resolves into a private network", async () => {
        mocks.resolve4.mockResolvedValue(["10.0.0.5"]);
        const internal = { ...custom, id: "d-internal", hostname: "internal.example.org" };
        mocks.appFindFirst.mockResolvedValue(
            app({ id: "0190aaaa-0000-7000-8000-0000000000b3", domains: [internal] })
        );
        const [reading] = await publicNet.domainReadings(
            "0190aaaa-0000-7000-8000-0000000000b3",
            OWNER
        );
        expect(reading?.cert?.verdict).toBe("unknown");
        expect(mocks.connect).not.toHaveBeenCalled();
    });

    it("dials the public address it resolved, naming the host for SNI", async () => {
        mocks.resolve4.mockResolvedValue(["104.16.1.2"]);
        const outside = { ...custom, id: "d-outside", hostname: "outside.example.org" };
        mocks.appFindFirst.mockResolvedValue(
            app({ id: "0190aaaa-0000-7000-8000-0000000000b4", domains: [outside] })
        );
        await publicNet.domainReadings("0190aaaa-0000-7000-8000-0000000000b4", OWNER);
        expect(mocks.connect).toHaveBeenCalledWith(
            expect.objectContaining({
                host: "104.16.1.2",
                servername: "outside.example.org",
                port: 443
            })
        );
    });
});
