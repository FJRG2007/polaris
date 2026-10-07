/**
 * The watcher that keeps a service's NAS volumes attached, and says when it cannot.
 *
 * The case it exists for: a NAS came back on a new address, the share was mounted
 * again, and a service started days earlier kept the dead mount - running, serving,
 * and answering "Host is down" for every file on both its volumes, with nobody told.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const LOCAL = { id: "t-local", kind: "local", hostId: null, runtime: "compose", proxyNetwork: "p" };

const row = {
    id: "app-1",
    slug: "orphion",
    target: LOCAL,
    environment: { project: { ownerId: "owner-1", slug: "orphion" } },
    volumes: [
        { name: "secrets", mountPath: "/app/secrets", connectionId: "share-1", connection: { name: "Office NAS" } },
        { name: "uploads", mountPath: "/app/uploads", connectionId: "share-1", connection: { name: "Office NAS" } }
    ]
};

const DEAD = { code: 1, output: "ls: /app/secrets: Host is down\nls: /app/uploads: Host is down\n" };
const FINE = { code: 0, output: "/app/secrets\n/app/uploads\n" };

/** What `ls` inside the service answers, one entry per call, the last repeating. */
let looks: Array<{ code: number; output: string } | Error> = [];
let mount: () => Promise<boolean> = async () => false;
let restartedByShare: string[] = [];

const ports = {
    ensureMount: vi.fn(() => mount()),
    runIn: vi.fn(async () => {
        const next = looks.length > 1 ? looks.shift()! : looks[0]!;
        if (next instanceof Error) throw next;
        return next;
    }),
    container: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined)
};
const notifyVolumeHealth = vi.fn(async () => undefined);
const restartAppsOnShare = vi.fn(async () => restartedByShare);

vi.mock("@polaris/db", () => ({ prisma: { application: { findMany: vi.fn(async () => [row]) } } }));
let nativeMounts = true;
vi.mock("@polaris/config", () => ({ getCapabilities: () => ({ nativeMounts }) }));
vi.mock("@/lib/deploy/runtime", () => ({ getPorts: vi.fn(async () => ports) }));
vi.mock("@/lib/storage-service", () => ({
    resolveMountTarget: vi.fn(async (id: string) => ({ id, kind: "smb", source: "//nas/share" }))
}));
vi.mock("@/lib/deploy-service", () => ({ restartAppsOnShare }));
vi.mock("@/lib/notifications/volume-events", () => ({ notifyVolumeHealth }));

/** A fresh watcher, as a fresh process would have: nothing said yet. */
async function watcher() {
    vi.resetModules();
    return import("@/lib/deploy/volume-watch");
}

beforeEach(() => {
    vi.clearAllMocks();
    looks = [FINE];
    mount = async () => false;
    restartedByShare = [];
    nativeMounts = true;
});

describe("a service holding a dead mount", () => {
    it("is restarted onto the live share, and its owner is told", async () => {
        looks = [DEAD, FINE];
        const { checkNasVolumes } = await watcher();
        await checkNasVolumes();
        expect(ports.container).toHaveBeenCalledWith(expect.stringContaining("orphion"), "restart");
        expect(notifyVolumeHealth).toHaveBeenCalledOnce();
        expect(notifyVolumeHealth).toHaveBeenCalledWith(
            { applicationId: "app-1", storage: "Office NAS", volumes: ["secrets", "uploads"] },
            "reconnected"
        );
    });

    it("is said to be down once when a restart does not bring the volumes back, and back when they are", async () => {
        looks = [DEAD];
        const { checkNasVolumes } = await watcher();
        await checkNasVolumes();
        await checkNasVolumes();
        expect(ports.container).toHaveBeenCalledOnce();
        expect(notifyVolumeHealth).toHaveBeenCalledOnce();
        expect(notifyVolumeHealth).toHaveBeenLastCalledWith(expect.anything(), "detached");

        looks = [FINE];
        await checkNasVolumes();
        expect(notifyVolumeHealth).toHaveBeenCalledTimes(2);
        expect(notifyVolumeHealth).toHaveBeenLastCalledWith(expect.anything(), "back");
    });
});

describe("a share that does not answer", () => {
    it("is said once, without restarting the service onto nothing, and its return is said", async () => {
        mount = async () => {
            throw new Error("mounting //nas/share failed: Host is down");
        };
        const { checkNasVolumes } = await watcher();
        await checkNasVolumes();
        await checkNasVolumes();
        expect(ports.container).not.toHaveBeenCalled();
        expect(notifyVolumeHealth).toHaveBeenCalledOnce();
        expect(notifyVolumeHealth).toHaveBeenLastCalledWith(expect.anything(), "unreachable");

        mount = async () => false;
        await checkNasVolumes();
        expect(notifyVolumeHealth).toHaveBeenLastCalledWith(expect.anything(), "back");
    });

    it("mounted again restarts everybody bound to it, who is not told twice", async () => {
        mount = async () => true;
        restartedByShare = ["app-1"];
        const { checkNasVolumes } = await watcher();
        await checkNasVolumes();
        expect(restartAppsOnShare).toHaveBeenCalledWith("share-1", null);
        // The share step said it already; the service answering after it is not news.
        expect(notifyVolumeHealth).not.toHaveBeenCalled();
    });

    it("mounted again by a deploy, after being said down, is not said back a second time", async () => {
        mount = async () => {
            throw new Error("mounting //nas/share failed: Host is down");
        };
        const { checkNasVolumes, forgetVolumeNotice } = await watcher();
        await checkNasVolumes();
        expect(notifyVolumeHealth).toHaveBeenLastCalledWith(expect.anything(), "unreachable");

        forgetVolumeNotice("app-1");
        mount = async () => false;
        await checkNasVolumes();
        expect(notifyVolumeHealth).toHaveBeenCalledOnce();
    });
});

describe("what does not count against a service", () => {
    it("is an image with no ls in it", async () => {
        looks = [{ code: 126, output: 'exec: "ls": executable file not found in $PATH' }];
        const { checkNasVolumes } = await watcher();
        await checkNasVolumes();
        expect(ports.container).not.toHaveBeenCalled();
        expect(notifyVolumeHealth).not.toHaveBeenCalled();
    });

    it("is a container that is not running to be asked", async () => {
        looks = [new Error("container is not running")];
        const { checkNasVolumes } = await watcher();
        await checkNasVolumes();
        expect(ports.container).not.toHaveBeenCalled();
        expect(notifyVolumeHealth).not.toHaveBeenCalled();
    });

    it("is an edition with no host daemon, which mounts nothing to watch", async () => {
        nativeMounts = false;
        mount = async () => {
            throw new Error("mount is only supported on Linux hosts");
        };
        const { checkNasVolumes } = await watcher();
        await checkNasVolumes();
        expect(ports.ensureMount).not.toHaveBeenCalled();
        expect(notifyVolumeHealth).not.toHaveBeenCalled();
    });

    it("is a healthy service, which nothing is said about", async () => {
        const { checkNasVolumes } = await watcher();
        await checkNasVolumes();
        await checkNasVolumes();
        expect(notifyVolumeHealth).not.toHaveBeenCalled();
    });
});
