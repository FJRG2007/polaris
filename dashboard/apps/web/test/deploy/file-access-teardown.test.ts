/**
 * Deleting a service takes its SFTP server down: the rows cascade with the
 * service, the container does not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    fileAccessServer: { findUnique: vi.fn(), deleteMany: vi.fn() },
    application: { findFirst: vi.fn() }
}));
const ports = vi.hoisted(() => ({ composeDown: vi.fn(), dispose: vi.fn() }));

vi.mock("@polaris/db", () => ({ prisma: db }));
vi.mock("@/lib/deployment-addresses", () => ({ reachableAddresses: async () => [] }));
vi.mock("@/lib/deploy/runtime", () => ({ getPorts: vi.fn(async () => ports) }));

import { takeDownFileAccess } from "@/lib/deploy/file-access";

const app = {
    id: "0190f3a2-7c41-7000-8000-000000000001",
    slug: "web",
    environment: { project: { slug: "shop" } },
    target: {
        id: "t1",
        kind: "local",
        hostId: null,
        runtime: "docker",
        proxyNetwork: null,
        host: null
    },
    volumes: []
};

beforeEach(() => {
    vi.clearAllMocks();
    db.application.findFirst.mockResolvedValue(app);
    db.fileAccessServer.deleteMany.mockResolvedValue({ count: 1 });
    ports.composeDown.mockResolvedValue(undefined);
    ports.dispose.mockResolvedValue(undefined);
});

describe("takeDownFileAccess", () => {
    it("does nothing for a service that never had a server", async () => {
        db.fileAccessServer.findUnique.mockResolvedValue(null);
        await takeDownFileAccess(app.id, "owner");
        expect(ports.composeDown).not.toHaveBeenCalled();
    });

    it("takes the server's project down and forgets it", async () => {
        db.fileAccessServer.findUnique.mockResolvedValue({ applicationId: app.id });
        await takeDownFileAccess(app.id, "owner");
        expect(ports.composeDown).toHaveBeenCalledWith(
            expect.stringMatching(/^polaris-sftp-[0-9a-f]{8}$/)
        );
        expect(db.fileAccessServer.deleteMany).toHaveBeenCalledWith({
            where: { applicationId: app.id }
        });
        expect(ports.dispose).toHaveBeenCalled();
    });

    it("never throws when the server does not answer", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
        db.fileAccessServer.findUnique.mockResolvedValue({ applicationId: app.id });
        ports.composeDown.mockRejectedValue(new Error("unreachable"));
        await expect(takeDownFileAccess(app.id, "owner")).resolves.toBeUndefined();
        expect(logged).toHaveBeenCalled();
        expect(ports.dispose).toHaveBeenCalled();
        logged.mockRestore();
    });
});
