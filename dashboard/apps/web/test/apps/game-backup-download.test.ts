/**
 * A world archive is only ever sent to somebody who asked to download it.
 *
 * A tab still running a build that linked the archives through the router
 * prefetches every one on screen as it is drawn - each of them gigabytes read out
 * of the container, over the same connection as the rest of the dashboard.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const requireGameServer = vi.fn();
const readContainerFile = vi.fn();

vi.mock("@/lib/apps/install-access", () => ({ requireGameServer }));
vi.mock("@/lib/container-files-service", () => ({ readContainerFile }));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/world-service", () => ({
    backupPathInContainer: (name: string) => `/data/backups/${name}`
}));

const { GET } = await import("@polaris-app/game-servers/src/routes/api/installed/minecraft/world/[name]/route");

const params = Promise.resolve({ id: "server", name: "2026-09-16T23-48-10-774.tar.gz" });

beforeEach(() => {
    requireGameServer.mockReset();
    readContainerFile.mockReset();
});

describe("downloading a world backup", () => {
    it.each(["rsc", "next-router-prefetch"])(
        "reads nothing for a router request (%s)",
        async (header) => {
            const response = await GET(
                new Request("http://polaris.test/x", { headers: { [header]: "1" } }),
                { params }
            );
            expect(response.status).toBe(204);
            expect(requireGameServer).not.toHaveBeenCalled();
            expect(readContainerFile).not.toHaveBeenCalled();
        }
    );

    it("streams the archive for a download", async () => {
        const { Readable } = await import("node:stream");
        requireGameServer.mockResolvedValue({
            access: { ownerId: "owner", install: { applicationId: "app", name: "Survival" } }
        });
        readContainerFile.mockResolvedValue(Readable.from([Buffer.from("archive")]));
        const response = await GET(new Request("http://polaris.test/x"), { params });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-disposition")).toContain("attachment");
        expect(await response.text()).toBe("archive");
    });
});
