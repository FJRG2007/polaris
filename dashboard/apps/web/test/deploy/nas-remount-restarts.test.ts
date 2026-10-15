/**
 * A share mounted again takes the services bound to it along.
 *
 * A container's bind resolves once, when it starts. When a NAS came back on a new
 * address, Drive found the old mount dead and mounted the share again - and the
 * service started days earlier kept the dead one, answering "Host is down" for
 * every file on both its volumes, because only the boot reconcile restarted
 * anything and it had nothing left to re-create.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface AppRow {
    id: string;
    slug: string;
    target: {
        id: string;
        kind: string;
        hostId: string | null;
        runtime: string;
        proxyNetwork: string;
    };
    environment: { project: { ownerId: string; slug: string } };
    volumes?: Array<{ connectionId: string; mountPath: string }>;
}

const LOCAL = { id: "t-local", kind: "local", hostId: null, runtime: "compose", proxyNetwork: "p" };

function app(id: string, connectionId = "share-1"): AppRow {
    return {
        id,
        slug: id,
        target: LOCAL,
        environment: { project: { ownerId: "owner-1", slug: "proj" } },
        volumes: [{ connectionId, mountPath: "/data" }]
    };
}

let rows: AppRow[] = [];
const findMany = vi.fn(async (args: { where: { id?: { not: string } } }) =>
    rows.filter((row) => row.id !== args.where.id?.not)
);
const restarted: string[] = [];
let created = true;
const ensureMount = vi.fn(async () => created);
/** What each service answers when asked where its volumes are; by default it
 *  cannot be asked, which is restarted the way it always was. */
let inside: (argv: readonly string[]) => { code: number; output: string } = () => {
    throw new Error("exec failed: no such tool");
};
const SHARE_TABLE = "40 30 0:52 /proj/vol /data rw,relatime - cifs //nas/share rw,mfsymlinks\n";
const LOCAL_TABLE = "41 30 8:1 /var/lib/docker/x /data rw,relatime - ext4 /dev/sda1 rw\n";
const ports = {
    ensureMount,
    runIn: vi.fn(async (_container: string, argv: readonly string[]) => inside(argv)),
    container: vi.fn(async (name: string) => {
        restarted.push(name);
    }),
    dispose: vi.fn(async () => undefined)
};

vi.mock("@polaris/db", () => ({ prisma: { application: { findMany } } }));
vi.mock("@/lib/deploy/runtime", async (load) => ({
    ...(await load<typeof import("@/lib/deploy/runtime")>()),
    getPorts: vi.fn(async () => ports)
}));
const notifyVolumeHealth = vi.fn(async () => undefined);
vi.mock("@/lib/notifications/volume-events", () => ({ notifyVolumeHealth }));
vi.mock("@/lib/storage-service", () => ({
    resolveMountTarget: vi.fn(async (id: string) => ({ id, kind: "smb", source: "//nas/share" }))
}));

const { reconcileNasMounts, restartAppsOnShare } = await import("@/lib/deploy-service");

beforeEach(() => {
    rows = [];
    created = true;
    inside = () => {
        throw new Error("exec failed: no such tool");
    };
    restarted.length = 0;
    findMany.mockClear();
    ensureMount.mockClear();
    notifyVolumeHealth.mockClear();
});

describe("a share mounted again", () => {
    it("restarts every running service on the machine bound to it", async () => {
        rows = [app("a"), app("b")];
        await restartAppsOnShare("share-1", null);
        expect(restarted).toHaveLength(2);
        // Each one's owner hears that its files were unreadable until now.
        expect(notifyVolumeHealth).toHaveBeenCalledTimes(2);
        expect(notifyVolumeHealth).toHaveBeenCalledWith(
            expect.objectContaining({ applicationId: "a" }),
            "reconnected"
        );
        const [args] = findMany.mock.calls[0] as [{ where: Record<string, unknown> }];
        expect(args.where).toMatchObject({
            desiredState: "running",
            volumes: { some: { kind: "nas", connectionId: "share-1" } },
            target: { OR: [{ kind: "local" }, { hostId: null }] }
        });
    });

    it("leaves out the service a deploy is bringing up on the fresh mount", async () => {
        rows = [app("a"), app("b")];
        await restartAppsOnShare("share-1", null, "a");
        expect(restarted).toHaveLength(1);
    });

    it("looks only at the remote machine the share was mounted on", async () => {
        await restartAppsOnShare("share-1", "host-9");
        const [args] = findMany.mock.calls[0] as [{ where: Record<string, unknown> }];
        expect(args.where.target).toEqual({ kind: { not: "local" }, hostId: "host-9" });
    });

    it("leaves running a service still on a live mount of the share", async () => {
        // An update that recreated the host daemon mounts the share again, while
        // every service keeps the mount it started with. Restarting those was the
        // downtime.
        rows = [app("a"), app("b")];
        inside = (argv) =>
            argv[0] === "cat" ? { code: 0, output: SHARE_TABLE } : { code: 0, output: "/data" };
        await expect(restartAppsOnShare("share-1", null)).resolves.toEqual([]);
        expect(restarted).toHaveLength(0);
        expect(notifyVolumeHealth).not.toHaveBeenCalled();
    });

    it("restarts a service whose mount is dead", async () => {
        rows = [app("a")];
        inside = (argv) =>
            argv[0] === "cat"
                ? { code: 0, output: SHARE_TABLE }
                : { code: 1, output: "ls: /data: Host is down" };
        await expect(restartAppsOnShare("share-1", null)).resolves.toEqual(["a"]);
    });

    it("restarts a service that started before the share was mounted", async () => {
        // Its volume is a folder on the machine's own disk, not the NAS.
        rows = [app("a")];
        inside = (argv) =>
            argv[0] === "cat" ? { code: 0, output: LOCAL_TABLE } : { code: 0, output: "/data" };
        await expect(restartAppsOnShare("share-1", null)).resolves.toEqual(["a"]);
    });

    it("keeps going when one service cannot be restarted", async () => {
        rows = [app("a"), app("b")];
        ports.container.mockRejectedValueOnce(new Error("no such container"));
        await expect(restartAppsOnShare("share-1", null)).resolves.toEqual(["b"]);
        expect(restarted).toHaveLength(1);
    });
});

describe("the boot reconcile", () => {
    it("restarts the second service on a share the first one re-created", async () => {
        // The first app's ensureMount re-creates the share; the second's would only
        // hear "already mounted", which is how it used to be left on the dead one.
        rows = [app("a"), app("b")];
        await reconcileNasMounts();
        expect(ensureMount).toHaveBeenCalledTimes(1);
        expect(restarted).toHaveLength(2);
    });

    it("touches nothing when the share was already live", async () => {
        rows = [app("a"), app("b")];
        created = false;
        await reconcileNasMounts();
        expect(restarted).toHaveLength(0);
    });
});
