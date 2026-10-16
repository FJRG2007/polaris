/**
 * The boot pass that closes host ports nobody chose, and the operator's close.
 *
 * At boot nobody asked, so only what changes over with no downtime moves: a kept
 * image to start again, a change-over the service can run, nothing of it already
 * deploying. Run again it does not start a second deploy for a port already on its
 * way closed, and once the release without the port is serving there is nothing
 * left to do. The operator's close takes every port they can close, chosen or not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface App {
    id: string;
    name: string;
    publishPort: boolean;
    publishPortChosen: boolean;
    sourceConfig: string;
    sourceType: string;
    keepReleases: boolean;
    overlapVolumes: boolean;
    currentDeploymentId: string | null;
    desiredState: string;
    asleepSince: Date | null;
    target: { kind: string; runtime: string };
    domains: { id: string }[];
    volumes: { name: string; kind: string; createdAt: Date }[];
    environment: { project: { ownerId: string } };
}

interface Row {
    id: string;
    deployableId: string;
    status: string;
    imageKept: boolean;
    imageTag: string | null;
}

let apps: App[] = [];
let deployments: Row[] = [];
let installed: string[] = [];
let asked: unknown[] = [];

function app(id: string, change: Partial<App> = {}): App {
    return {
        id,
        name: id,
        publishPort: true,
        publishPortChosen: false,
        sourceConfig: "{}",
        sourceType: "image",
        keepReleases: false,
        overlapVolumes: false,
        currentDeploymentId: `${id}-live`,
        desiredState: "running",
        asleepSince: null,
        target: { kind: "local", runtime: "compose" },
        domains: [{ id: `${id}-domain` }],
        volumes: [],
        environment: { project: { ownerId: "owner" } },
        ...change
    };
}

function live(id: string, imageKept = true): Row {
    return {
        id: `${id}-live`,
        deployableId: id,
        status: "running",
        imageKept,
        imageTag: "polaris-release/web:0123456789ab"
    };
}

vi.mock("@polaris/db", () => ({
    prisma: {
        application: {
            findMany: async (args: { where: Record<string, unknown> }) => {
                asked.push(args.where);
                const ids = (args.where.id as { in?: string[] } | undefined)?.in;
                if (ids) return apps.filter((row) => ids.includes(row.id));
                // What the boot query asks of the database: running, published, local.
                return apps.filter(
                    (row) =>
                        row.publishPort &&
                        row.desiredState === "running" &&
                        row.asleepSince === null &&
                        row.currentDeploymentId !== null &&
                        !row.keepReleases &&
                        row.target.kind === "local"
                );
            }
        },
        installedApp: {
            findMany: async () => installed.map((applicationId) => ({ applicationId }))
        },
        mailServer: { findMany: async () => [] },
        deployment: {
            findMany: async (args: {
                where: { id?: { in: string[] }; deployableId?: { in: string[] }; status?: { in: string[] } };
            }) => {
                if (args.where.status) {
                    return deployments.filter(
                        (row) =>
                            args.where.status?.in.includes(row.status) &&
                            (args.where.deployableId?.in ?? []).includes(row.deployableId)
                    );
                }
                return deployments.filter((row) => (args.where.id?.in ?? []).includes(row.id));
            },
            findUnique: async (args: { where: { id: string } }) => {
                const row = deployments.find((entry) => entry.id === args.where.id);
                return row ? { status: row.status, startedAt: new Date(0), createdAt: new Date(0) } : null;
            }
        }
    }
}));

/** Closing queues a deploy that has not been promoted yet. */
const setApplicationPublishPort = vi.fn(async (applicationId: string) => {
    deployments.push({
        id: `${applicationId}-closing`,
        deployableId: applicationId,
        status: "queued",
        imageKept: false,
        imageTag: null
    });
    return { redeployed: true };
});
vi.mock("@/lib/deploy-service", () => ({ setApplicationPublishPort }));

const { closeDirectPorts, closesQuietly } = await import("../../src/lib/deploy/direct-port-close");

/** The release that closes the port is promoted: the port is stored closed. */
function promote(id: string) {
    const row = deployments.find((entry) => entry.id === `${id}-closing`);
    if (row) row.status = "running";
    const found = apps.find((entry) => entry.id === id);
    if (found) found.publishPort = false;
}

beforeEach(() => {
    apps = [];
    deployments = [];
    installed = [];
    asked = [];
    setApplicationPublishPort.mockClear();
});

describe("closesQuietly", () => {
    const quiet = { cutover: true, volumesPending: false, imageKept: true, deploying: false };

    it("moves a service that changes over from the image it runs", () => {
        expect(closesQuietly(quiet)).toBe(true);
    });

    it.each([
        ["it cannot run two copies at once", { cutover: false }],
        ["a volume it mounts does not exist yet", { volumesPending: true }],
        ["its image would have to be built again", { imageKept: false }],
        ["a deploy of it is already queued or running", { deploying: true }]
    ])("leaves it for its next deploy when %s", (_why, change) => {
        expect(closesQuietly({ ...quiet, ...change })).toBe(false);
    });
});

describe("closeDirectPorts at boot", () => {
    it("closes once, does not start a second deploy, and is done once promoted", async () => {
        apps = [app("web")];
        deployments = [live("web")];

        const first = await closeDirectPorts({}, { mode: "boot", actorId: null });
        expect(first).toEqual({ closed: ["web"], failed: [], deferred: [] });
        expect(setApplicationPublishPort).toHaveBeenCalledTimes(1);
        expect(setApplicationPublishPort).toHaveBeenCalledWith("web", "owner", false, null);

        // A restart before the change-over finished: the deploy is still in flight.
        const second = await closeDirectPorts({}, { mode: "boot", actorId: null });
        expect(second).toEqual({ closed: [], failed: [], deferred: ["web"] });
        expect(setApplicationPublishPort).toHaveBeenCalledTimes(1);

        promote("web");
        const third = await closeDirectPorts({}, { mode: "boot", actorId: null });
        expect(third).toEqual({ closed: [], failed: [], deferred: [] });
        expect(setApplicationPublishPort).toHaveBeenCalledTimes(1);
    });

    it("never touches a port somebody chose, pinned, or that is the only way in", async () => {
        apps = [
            app("chosen", { publishPortChosen: true }),
            app("game", { sourceConfig: '{"hostPort":25565}' }),
            app("internal", { domains: [] }),
            app("installed")
        ];
        installed = ["installed"];
        deployments = apps.map((row) => live(row.id));
        const outcome = await closeDirectPorts({}, { mode: "boot", actorId: null });
        expect(outcome).toEqual({ closed: [], failed: [], deferred: [] });
        expect(setApplicationPublishPort).not.toHaveBeenCalled();
    });

    it("defers what would go down or be rebuilt to close it", async () => {
        apps = [
            app("volumes", { volumes: [{ name: "data", kind: "volume", createdAt: new Date(0) }] }),
            app("rebuild"),
            app("proxied", { sourceConfig: '{"tcpProxies":[{"host":5432,"container":5432}]}' }),
            app("stack", { sourceType: "compose" })
        ];
        deployments = [live("volumes"), live("rebuild", false), live("proxied"), live("stack")];
        const outcome = await closeDirectPorts({}, { mode: "boot", actorId: null });
        expect(outcome.closed).toEqual([]);
        expect([...outcome.deferred].sort()).toEqual(["proxied", "rebuild", "stack", "volumes"]);
        expect(setApplicationPublishPort).not.toHaveBeenCalled();
    });

    it("keeps going past a service it could not close, and says which", async () => {
        apps = [app("a"), app("b")];
        deployments = [live("a"), live("b")];
        setApplicationPublishPort.mockRejectedValueOnce(new Error("refused"));
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const outcome = await closeDirectPorts({}, { mode: "boot", actorId: null });
        error.mockRestore();
        expect(outcome).toEqual({ closed: ["b"], failed: ["a"], deferred: [] });
    });

    it("asks only for running, published services on this machine", async () => {
        await closeDirectPorts({}, { mode: "boot", actorId: null });
        expect(asked[0]).toEqual({
            binnedAt: null,
            AND: [
                {},
                {
                    publishPort: true,
                    desiredState: "running",
                    asleepSince: null,
                    currentDeploymentId: { not: null },
                    keepReleases: false,
                    target: { kind: "local" }
                }
            ]
        });
    });
});

describe("closeDirectPorts for the operator", () => {
    it("closes a chosen port too, and still not an installed app's or an unrouted one", async () => {
        apps = [app("chosen", { publishPortChosen: true }), app("installed"), app("internal", { domains: [] })];
        installed = ["installed"];
        deployments = apps.map((row) => live(row.id));
        const outcome = await closeDirectPorts({ id: "x" }, { mode: "operator", actorId: "user-1" });
        expect(outcome).toEqual({ closed: ["chosen"], failed: [], deferred: [] });
        expect(setApplicationPublishPort).toHaveBeenCalledWith("chosen", "owner", false, "user-1");
    });
});
