/**
 * A redeploy of a routed service changes over with no gap, in this order: the new
 * release comes up beside the old one and proves it serves, the edge's route is
 * rewritten to dial the new release by its own name, the old one is drained, and
 * only then is it taken down. These drive the real runner and the real route
 * writer against a stateful stand-in for the database and a recording stand-in for
 * the machine and the edge, and read back the order things happened in.
 *
 * And the two ways it must not end: a new release that does not come up is taken
 * down while the old one keeps serving and the route never names it; and an edge
 * that could not be told keeps the old release running rather than taking down the
 * only one it still dials.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { releaseMarker, releaseRef, serviceRef } from "@/lib/deploy/releases";

const dataDir = await mkdtemp(join(tmpdir(), "polaris-cutover-test-"));

type Row = Record<string, unknown> & { id: string };

const { db, ops, routerSync } = vi.hoisted(() => ({
    db: { deployments: new Map<string, Record<string, unknown> & { id: string }>(), app: {} as Record<string, unknown> },
    ops: [] as string[],
    routerSync: { fail: false }
}));

/** Whether a row matches a Prisma-shaped `where`, for the handful of shapes used. */
function matches(row: Row, where: Record<string, unknown> = {}): boolean {
    return Object.entries(where).every(([key, wanted]) => {
        const value = row[key];
        if (wanted && typeof wanted === "object" && !(wanted instanceof Date)) {
            const cond = wanted as { not?: unknown; in?: unknown[]; notIn?: unknown[] };
            if ("not" in cond && value === cond.not) return false;
            if (cond.in && !cond.in.includes(value)) return false;
            if (cond.notIn && cond.notIn.includes(value)) return false;
            return true;
        }
        return value === wanted;
    });
}

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_DATA_DIR: dataDir }) }));
vi.mock("@polaris/db", () => {
    const deployments = () => [...db.deployments.values()];
    return {
        prisma: {
            deployment: {
                findUnique: vi.fn(async (args: { where: { id: string } }) => db.deployments.get(args.where.id) ?? null),
                findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => deployments().find((row) => matches(row, args.where)) ?? null),
                findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => deployments().filter((row) => matches(row, args.where))),
                count: vi.fn(async (args: { where?: Record<string, unknown> }) => deployments().filter((row) => matches(row, args.where)).length),
                update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
                    const row = db.deployments.get(args.where.id);
                    if (row) Object.assign(row, args.data);
                    return row;
                }),
                updateMany: vi.fn(async (args: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
                    const hit = deployments().filter((row) => matches(row, args.where));
                    for (const row of hit) Object.assign(row, args.data);
                    return { count: hit.length };
                })
            },
            application: {
                findUnique: vi.fn(async () => db.app),
                findFirst: vi.fn(async () => db.app),
                findMany: vi.fn(async () => [db.app]),
                update: vi.fn(async (args: { data: Record<string, unknown> }) => Object.assign(db.app, args.data))
            },
            domain: {
                findMany: vi.fn(async () => [
                    {
                        id: "dom-1",
                        hostname: "shop.example.test",
                        pathPrefix: null,
                        certResolver: "internal",
                        targetPort: 3000,
                        servedBy: "server",
                        applicationId: "app-1",
                        deploymentId: null,
                        application: db.app
                    }
                ]),
                deleteMany: vi.fn(async () => ({ count: 0 }))
            },
            host: { findMany: vi.fn(async () => []) }
        }
    };
});
vi.mock("@/lib/notifications/deploy-events", () => ({ notifyDeployFinished: vi.fn(async () => undefined) }));
vi.mock("@/lib/deploy/github-deployment", () => ({
    announceDeployFinished: vi.fn(async () => undefined),
    announceDeployQueued: vi.fn(async () => undefined),
    announceDeployStarted: vi.fn(async () => undefined)
}));
vi.mock("@/lib/deploy/edge-state", () => ({
    floodedServices: vi.fn(async () => new Set()),
    challengeActive: vi.fn(async () => false)
}));
vi.mock("@/lib/deploy/dial", () => ({ localDialHost: vi.fn(async () => "10.0.0.5") }));
vi.mock("@/lib/deploy/quick-tunnel-service", () => ({
    quickTunnelAppIds: vi.fn(async () => []),
    tunnelHostForApp: vi.fn(),
    stopQuickTunnel: vi.fn()
}));
vi.mock("@/lib/domain-zones", () => ({
    deployHostname: vi.fn(),
    deployZoneHosts: vi.fn(async () => []),
    isBaseZoneKey: vi.fn()
}));
vi.mock("@/lib/waf-service", () => ({ resolveWaf: vi.fn(), resolveWafBatch: vi.fn(async () => new Map()) }));
vi.mock("@/lib/domain-service", () => ({
    appBaseUrl: vi.fn(async () => "https://polaris.example.test"),
    getPublicIp: vi.fn(async () => "10.0.0.5")
}));
vi.mock("@/lib/cdn", () => ({ purgeAfterPromotion: vi.fn(async () => undefined) }));
vi.mock("@/lib/deploy/router", () => ({
    LocalRouter: class {
        public async sync(routes: { hostname: string; dialHost: string }[]): Promise<void> {
            if (routerSync.fail) throw new Error("the edge directory is read-only");
            for (const route of routes) ops.push(`route ${route.hostname} -> ${route.dialHost}`);
        }
    }
}));
vi.mock("@/lib/deploy/runtime", () => ({
    getPorts: vi.fn(async () => ({
        composeDown: vi.fn(async (project: string) => void ops.push(`down ${project}`)),
        removeImage: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined)
    })),
    getDriver: vi.fn(() => ({})),
    toTargetInfo: vi.fn(() => ({ id: "target-1", kind: "local", engine: "compose", proxyNetwork: "polaris-proxy" }))
}));

const service = await import("@/lib/deploy-service");

const TARGET = { id: "target-1", kind: "local", hostId: null, runtime: "compose", proxyNetwork: "polaris-proxy" };
const base = serviceRef("acme", "shop", "app-1");
const nameOf = (id: string) => releaseRef(base, releaseMarker({ id })).name;
const projectOf = (id: string) => releaseRef(base, releaseMarker({ id })).project;

function deployment(id: string, status: string): Row {
    return {
        id,
        status,
        deployableType: "application",
        deployableId: "app-1",
        isolated: true,
        cutover: true,
        commitSha: null,
        replicas: 1,
        createdAt: new Date("2026-10-01T10:00:00Z"),
        startedAt: new Date("2026-10-01T10:00:00Z")
    };
}

beforeEach(() => {
    ops.length = 0;
    routerSync.fail = false;
    db.deployments.clear();
    db.deployments.set("dep-old", deployment("dep-old", "running"));
    db.deployments.set("dep-new", deployment("dep-new", "queued"));
    Object.assign(db.app, {
        id: "app-1",
        slug: "shop",
        keepReleases: false,
        currentDeploymentId: "dep-old",
        publishPort: false,
        edgeConfig: "{}",
        sourceType: "image",
        sourceConfig: '{"port":3000}',
        replicas: 1,
        asleepSince: null,
        volumes: [],
        target: { kind: "local", hostId: null, runtime: "compose" },
        environment: { project: { slug: "acme", ownerId: "owner-1" } }
    });
    vi.spyOn(service.cutoverClock, "drain").mockImplementation(async () => void ops.push("drain"));
});

/** The runner's own work, standing in for the compose runtime: up, then the verdict. */
function release(ok: boolean) {
    return async () => {
        ops.push(`up ${projectOf("dep-new")}`);
        ops.push(ok ? "serving" : "did not come up");
        return ok ? { ok: true, imageTag: "polaris-release/shop:abc" } : { ok: false, error: "it did not" };
    };
}

describe("a change-over redeploy of a routed service", () => {
    it("switches the edge to the new release only after it serves, then drains, then stops the old one", async () => {
        await service.executeDeployment("dep-new", TARGET as never, "owner-1", release(true));

        expect(ops).toEqual([
            `up ${projectOf("dep-new")}`,
            "serving",
            `route shop.example.test -> ${nameOf("dep-new")}`,
            "drain",
            `down ${projectOf("dep-old")}`
        ]);
        expect(db.app.currentDeploymentId).toBe("dep-new");
        expect(db.deployments.get("dep-old")?.status).toBe("removed");
        expect(db.deployments.get("dep-new")?.status).toBe("running");
    });

    it("leaves the old release serving and the route untouched when the new one does not come up", async () => {
        await service.executeDeployment("dep-new", TARGET as never, "owner-1", release(false));

        expect(ops).toEqual([`up ${projectOf("dep-new")}`, "did not come up", `down ${projectOf("dep-new")}`]);
        expect(db.app.currentDeploymentId).toBe("dep-old");
        expect(db.deployments.get("dep-old")?.status).toBe("running");
        expect(db.deployments.get("dep-new")?.status).toBe("failed");
    });

    it("keeps the old release running when the edge could not be given the new route", async () => {
        routerSync.fail = true;
        await service.executeDeployment("dep-new", TARGET as never, "owner-1", release(true));

        // Nothing taken down: the edge still dials the old release by name.
        expect(ops).toEqual([`up ${projectOf("dep-new")}`, "serving"]);
        expect(db.deployments.get("dep-old")?.status).toBe("running");
        expect(db.deployments.get("dep-new")?.status).toBe("running");
    });

    it("retires a release the edge could not be moved off, on the next promotion that reaches it", async () => {
        routerSync.fail = true;
        await service.executeDeployment("dep-new", TARGET as never, "owner-1", release(true));
        routerSync.fail = false;
        ops.length = 0;
        db.deployments.set("dep-next", deployment("dep-next", "queued"));
        await service.executeDeployment("dep-next", TARGET as never, "owner-1", async () => ({
            ok: true,
            imageTag: "polaris-release/shop:def"
        }));

        expect(ops[0]).toBe(`route shop.example.test -> ${nameOf("dep-next")}`);
        expect(ops).toContain(`down ${projectOf("dep-old")}`);
        expect(ops).toContain(`down ${projectOf("dep-new")}`);
        expect(ops.indexOf("drain")).toBeLessThan(ops.indexOf(`down ${projectOf("dep-old")}`));
    });

    it("retires a release the edge could not be moved off once a later route sync reaches it", async () => {
        routerSync.fail = true;
        db.deployments.get("dep-new")!.createdAt = new Date("2026-10-01T11:00:00Z");
        await service.executeDeployment("dep-new", TARGET as never, "owner-1", release(true));
        routerSync.fail = false;
        ops.length = 0;

        await service.syncAppRoutes();

        expect(ops).toEqual([
            `route shop.example.test -> ${nameOf("dep-new")}`,
            "drain",
            `down ${projectOf("dep-old")}`
        ]);
        expect(db.deployments.get("dep-old")?.status).toBe("removed");
        expect(db.deployments.get("dep-new")?.status).toBe("running");
    });

    it("never retires a release newer than the one serving", async () => {
        db.deployments.get("dep-new")!.status = "running";
        db.deployments.get("dep-new")!.createdAt = new Date("2026-10-01T11:00:00Z");

        await service.syncAppRoutes();

        expect(ops).toEqual([`route shop.example.test -> ${nameOf("dep-old")}`]);
        expect(db.deployments.get("dep-new")?.status).toBe("running");
    });
});

describe("an in-place deploy after a change-over release that shares its volumes", () => {
    function inPlace() {
        Object.assign(db.deployments.get("dep-new")!, { isolated: false, cutover: false });
        db.app.volumes = [{ kind: "volume" }];
        const ports = {
            composeUp: vi.fn(async (spec: { project: string }) => void ops.push(`up ${spec.project}`)),
            composeDown: vi.fn(async (project: string) => void ops.push(`down ${project}`)),
            pull: vi.fn(async () => undefined)
        };
        return { ports, log: vi.fn() };
    }

    it("stops the change-over release right before the in-place one starts on the same volumes", async () => {
        const ctx = inPlace();
        const wrapped = await service.sharedVolumesFreedBeforeUp("dep-new", { ref: base } as never, ctx as never);

        await wrapped.ports.pull("img");
        expect(ops).toEqual([]);
        await wrapped.ports.composeUp({ project: base.project } as never);
        await wrapped.ports.composeUp({ project: base.project } as never);

        expect(ops).toEqual([`down ${projectOf("dep-old")}`, `up ${base.project}`, `up ${base.project}`]);
    });

    it("leaves the running release alone when the service has no named volume", async () => {
        const ctx = inPlace();
        db.app.volumes = [{ kind: "bind" }];
        const wrapped = await service.sharedVolumesFreedBeforeUp("dep-new", { ref: base } as never, ctx as never);

        expect(wrapped).toBe(ctx);
    });

    it("leaves it alone for a deploy that changes over itself", async () => {
        const ctx = inPlace();
        Object.assign(db.deployments.get("dep-new")!, { isolated: true, cutover: true });
        const wrapped = await service.sharedVolumesFreedBeforeUp("dep-new", { ref: base } as never, ctx as never);

        expect(wrapped).toBe(ctx);
    });
});
