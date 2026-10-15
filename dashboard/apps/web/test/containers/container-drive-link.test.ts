/**
 * The container page's "Open in Drive".
 *
 * Where it leads is worked out from what the viewer may open: their own Deploy
 * service is a container source in Drive, any other container is reached through
 * the server it runs on - and only when that server is one of their Drive
 * sources. No answer means no button, never one that ends in a refusal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { driveHref, hostFolderFor } from "@/lib/container-drive-link";

const findManyApplications = vi.fn();
const findUniqueHost = vi.fn();
const servingReleases = vi.fn();
const managesServers = vi.fn(async () => false);
let localHostId: string | null = "local-host";

vi.mock("@polaris/db", () => ({
    prisma: {
        application: { findMany: findManyApplications },
        host: { findUnique: findUniqueHost }
    }
}));
vi.mock("@/lib/session", () => ({ requirePermission: async () => ({ id: "viewer" }) }));
vi.mock("@/lib/local-server", () => ({ getLocalHostId: async () => localHostId }));
vi.mock("@/lib/deploy/releases", () => ({ servingReleases }));
vi.mock("@/lib/effective-access", () => ({
    effectiveCan: async () => false,
    effectiveIsAdmin: async () => false
}));
vi.mock("@/lib/drive-root", async () => {
    const actual = await vi.importActual<typeof import("@/lib/drive-root")>("@/lib/drive-root");
    return { reachesLocalHost: actual.reachesLocalHost, managesServers };
});
vi.mock("@/lib/docker-service", () => ({
    HOST_DOCKER_PREFIX: "host:",
    LOCAL_DOCKER_CONNECTION_ID: "local"
}));
vi.mock("@/lib/storage-service", () => ({
    CONTAINER_CONNECTION_PREFIX: "container:",
    HOST_CONNECTION_PREFIX: "host:"
}));

const { containerDriveLinkAction } = await import(
    "@/app/(app)/apps/containers/[containerId]/drive-link-actions"
);

describe("hostFolderFor", () => {
    const mounts = [
        { source: "/srv/app/data", destination: "/data" },
        { source: "/srv/app/cache", destination: "/data/cache" }
    ];

    it("follows a folder inside a mount to the host folder behind it", () => {
        expect(hostFolderFor(mounts, "/data/uploads")).toBe("srv/app/data/uploads");
        expect(hostFolderFor(mounts, "/data")).toBe("srv/app/data");
    });

    it("prefers the deepest mount, which shadows the one around it", () => {
        expect(hostFolderFor(mounts, "/data/cache/x")).toBe("srv/app/cache/x");
    });

    it("does not treat a sibling with a shared prefix as inside a mount", () => {
        expect(hostFolderFor(mounts, "/database")).toBe("srv/app/data");
    });

    it("opens the first mount when the page is outside them all", () => {
        expect(hostFolderFor(mounts, "/")).toBe("srv/app/data");
        expect(hostFolderFor(mounts, "/etc")).toBe("srv/app/data");
    });

    it("has no host folder without a mount whose source is a path", () => {
        expect(hostFolderFor([], "/")).toBeNull();
        expect(hostFolderFor([{ source: "tmpfs", destination: "/tmp" }], "/tmp")).toBeNull();
    });
});

describe("driveHref", () => {
    it("addresses the folder relative to the source, and the root without one", () => {
        expect(driveHref("host:h1", "/srv/app/")).toBe("/drive?c=host%3Ah1&p=srv%2Fapp");
        expect(driveHref("container:a1", "/")).toBe("/drive?c=container%3Aa1");
    });
});

describe("containerDriveLinkAction", () => {
    const mounts = [{ source: "/srv/app/data", destination: "/data" }];

    beforeEach(() => {
        vi.clearAllMocks();
        localHostId = "local-host";
        findManyApplications.mockResolvedValue([]);
        servingReleases.mockResolvedValue(new Map());
        managesServers.mockResolvedValue(false);
        findUniqueHost.mockResolvedValue(null);
    });

    it("opens the viewer's own Deploy service as its container source, at the page's folder", async () => {
        findManyApplications.mockResolvedValue([{ id: "app-1", currentDeploymentId: "d1" }]);
        servingReleases.mockResolvedValue(new Map([["app-1", { name: "web-1" }]]));
        const href = await containerDriveLinkAction({
            connectionId: "local",
            containerName: "/web-1",
            path: "/app/public",
            mounts: []
        });
        expect(href).toBe("/drive?c=container%3Aapp-1&p=app%2Fpublic");
    });

    it("opens a server the viewer enrolled at the mount behind the folder", async () => {
        findUniqueHost.mockResolvedValue({ ownerId: "viewer" });
        const href = await containerDriveLinkAction({
            connectionId: "host:h1",
            containerName: "db",
            path: "/data/pg",
            mounts
        });
        expect(href).toBe("/drive?c=host%3Ah1&p=srv%2Fapp%2Fdata%2Fpg");
    });

    it("offers nothing on somebody else's server", async () => {
        findUniqueHost.mockResolvedValue({ ownerId: "someone-else" });
        const href = await containerDriveLinkAction({
            connectionId: "host:h1",
            containerName: "db",
            path: "/data",
            mounts
        });
        expect(href).toBeNull();
    });

    it("opens the machine Polaris runs on for whoever manages servers, whoever enrolled it", async () => {
        findUniqueHost.mockResolvedValue({ ownerId: "first-admin" });
        managesServers.mockResolvedValue(true);
        const href = await containerDriveLinkAction({
            connectionId: "local",
            containerName: "redis",
            path: "/data",
            mounts
        });
        expect(href).toBe("/drive?c=host%3Alocal-host&p=srv%2Fapp%2Fdata");
    });

    it("offers nothing on the local machine to a viewer who does not manage servers", async () => {
        findUniqueHost.mockResolvedValue({ ownerId: "first-admin" });
        const href = await containerDriveLinkAction({
            connectionId: "local",
            containerName: "redis",
            path: "/data",
            mounts
        });
        expect(href).toBeNull();
    });

    it("offers nothing for a container with no folder on the host", async () => {
        findUniqueHost.mockResolvedValue({ ownerId: "viewer" });
        const href = await containerDriveLinkAction({
            connectionId: "host:h1",
            containerName: "worker",
            path: "/",
            mounts: []
        });
        expect(href).toBeNull();
        expect(findUniqueHost).not.toHaveBeenCalled();
    });

    it("offers nothing for a saved Docker connection, which is not a Drive source", async () => {
        const href = await containerDriveLinkAction({
            connectionId: "3f6c1b8e-0000-4000-8000-000000000000",
            containerName: "web",
            path: "/data",
            mounts
        });
        expect(href).toBeNull();
    });

    it("refuses input that is not the expected shape", async () => {
        expect(
            await containerDriveLinkAction({
                connectionId: "host:h1",
                containerName: "db",
                path: "data",
                mounts
            })
        ).toBeNull();
        expect(
            await containerDriveLinkAction({
                connectionId: "",
                containerName: "db",
                path: "/",
                mounts
            })
        ).toBeNull();
        expect(await containerDriveLinkAction(null)).toBeNull();
    });
});
