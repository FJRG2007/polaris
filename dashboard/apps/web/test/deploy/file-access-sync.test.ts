/**
 * The SFTP server follows what it serves: an account removed is gone from the
 * server before it is gone from the list, a service moved to another server
 * takes its server with it, and a change to the volumes starts it again.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    application: { findFirst: vi.fn() },
    deployTarget: { findUnique: vi.fn() },
    fileAccessAccount: { findMany: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() },
    fileAccessServer: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        deleteMany: vi.fn()
    }
}));
const runtime = vi.hoisted(() => {
    const ports = new Map<
        string,
        {
            composeUp: ReturnType<typeof vi.fn>;
            composeDown: ReturnType<typeof vi.fn>;
            dispose: ReturnType<typeof vi.fn>;
        }
    >();
    const on = (targetId: string) => {
        if (!ports.has(targetId))
            ports.set(targetId, {
                composeUp: vi.fn(async () => undefined),
                composeDown: vi.fn(async () => undefined),
                dispose: vi.fn(async () => undefined)
            });
        return ports.get(targetId)!;
    };
    return { ports, on };
});

vi.mock("@polaris/db", () => ({ prisma: db }));
vi.mock("@/lib/deployment-addresses", () => ({ reachableAddresses: async () => [] }));
vi.mock("@/lib/deploy/runtime", () => ({
    getPorts: vi.fn(async (target: { id: string }) => runtime.on(target.id))
}));

import { deleteFileAccessAccount, refreshFileAccess } from "@/lib/deploy/file-access";

const APP = "0190f3a2-7c41-7000-8000-000000000001";
const target = (id: string) => ({
    id,
    kind: "local",
    hostId: null,
    runtime: "docker",
    proxyNetwork: "polaris",
    host: null
});
const volume = { name: "uploads", kind: "volume", source: "uploads", connectionId: null };
const keyOnly = (id: string, username: string) => ({
    id,
    username,
    readOnly: false,
    passwordCipher: null,
    passwordNonce: null,
    passwordKeyId: null,
    publicKey: "ssh-ed25519 AAAA me"
});

function service(targetId: string, volumes = [volume]) {
    db.application.findFirst.mockResolvedValue({ id: APP, target: target(targetId), volumes });
}

beforeEach(() => {
    vi.clearAllMocks();
    runtime.ports.clear();
    service("t1");
    db.fileAccessServer.findMany.mockResolvedValue([]);
    db.fileAccessServer.findUnique.mockResolvedValue({
        applicationId: APP,
        targetId: "t1",
        port: 42222
    });
    db.fileAccessAccount.findFirst.mockResolvedValue({ id: "a1" });
    db.fileAccessAccount.findMany.mockResolvedValue([keyOnly("a2", "viewer")]);
});

describe("deleteFileAccessAccount", () => {
    it("starts the server without the account, then forgets it", async () => {
        await deleteFileAccessAccount(APP, "owner", "a1");
        expect(db.fileAccessAccount.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { applicationId: APP, id: { not: "a1" } } })
        );
        expect(runtime.on("t1").composeUp).toHaveBeenCalled();
        expect(db.fileAccessAccount.deleteMany).toHaveBeenCalledWith({
            where: { id: "a1", applicationId: APP }
        });
    });

    it("keeps the account listed when the server could not be told", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
        runtime.on("t1").composeUp.mockRejectedValue(new Error("unreachable"));
        await expect(deleteFileAccessAccount(APP, "owner", "a1")).rejects.toThrow(
            "fileAccess.startFailed"
        );
        expect(db.fileAccessAccount.deleteMany).not.toHaveBeenCalled();
        logged.mockRestore();
    });

    it("keeps the last account when the server could not be taken down", async () => {
        db.fileAccessAccount.findMany.mockResolvedValue([]);
        runtime.on("t1").composeDown.mockRejectedValue(new Error("unreachable"));
        await expect(deleteFileAccessAccount(APP, "owner", "a1")).rejects.toThrow("unreachable");
        expect(db.fileAccessAccount.deleteMany).not.toHaveBeenCalled();
    });
});

describe("refreshFileAccess", () => {
    it("does nothing for a service with no server", async () => {
        db.fileAccessServer.findUnique.mockResolvedValue(null);
        await refreshFileAccess(APP, "owner");
        expect(runtime.ports.size).toBe(0);
    });

    it("takes the server down on the old server after a move and starts it on a port of the new one", async () => {
        service("t2");
        db.deployTarget.findUnique.mockResolvedValue(target("t1"));
        db.fileAccessServer.findUnique.mockResolvedValue({
            applicationId: APP,
            targetId: "t1",
            port: 42222
        });
        await refreshFileAccess(APP, "owner");
        expect(runtime.on("t1").composeDown).toHaveBeenCalledWith(
            expect.stringMatching(/^polaris-sftp-/)
        );
        expect(db.fileAccessServer.deleteMany).toHaveBeenCalledWith({
            where: { applicationId: APP }
        });
        expect(db.fileAccessServer.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { targetId: "t2", applicationId: { not: APP } } })
        );
        expect(db.fileAccessServer.create).toHaveBeenCalledWith({
            data: { applicationId: APP, targetId: "t2", port: expect.any(Number) }
        });
        expect(runtime.on("t2").composeUp).toHaveBeenCalled();
    });

    it("mounts the volumes as they are now", async () => {
        service("t1", [
            volume,
            { name: "media", kind: "bind", source: "sites/media", connectionId: null }
        ]);
        await refreshFileAccess(APP, "owner");
        const [spec] = runtime.on("t1").composeUp.mock.calls[0];
        expect(spec.services[0].volumes.map((mount: { target: string }) => mount.target)).toEqual([
            "/srv/uploads",
            "/srv/media",
            "/etc/ssh/polaris-keys"
        ]);
    });

    it("stops serving when the last volume is gone, and says why", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
        service("t1", []);
        await refreshFileAccess(APP, "owner");
        expect(runtime.on("t1").composeDown).toHaveBeenCalled();
        expect(runtime.on("t1").composeUp).not.toHaveBeenCalled();
        expect(db.fileAccessServer.update).toHaveBeenCalledWith({
            where: { applicationId: APP },
            data: { lastError: "fileAccess.noVolumes", startedAt: null }
        });
        logged.mockRestore();
    });

    it("never serves a server folder Polaris keeps for itself", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
        service("t1", [
            { name: "homes", kind: "bind", source: "agent-homes/someone", connectionId: null }
        ]);
        await refreshFileAccess(APP, "owner");
        expect(runtime.on("t1").composeUp).not.toHaveBeenCalled();
        expect(runtime.on("t1").composeDown).toHaveBeenCalled();
        logged.mockRestore();
    });
});
