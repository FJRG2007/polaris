/**
 * Renaming a server reaches its deploy target, because the relay picker and the
 * deploy screens show the target's name.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { host, deployTarget } = vi.hoisted(() => ({
    host: { updateMany: vi.fn() },
    deployTarget: { updateMany: vi.fn() }
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        $transaction: (run: (tx: unknown) => unknown) => run({ host, deployTarget })
    }
}));

import { renameHost } from "@/lib/host-service";

beforeEach(() => vi.clearAllMocks());

describe("renameHost", () => {
    it("carries the new name to the server's deploy target", async () => {
        host.updateMany.mockResolvedValue({ count: 1 });
        expect(await renameHost("owner", "server", "ionos")).toBe("renamed");
        expect(deployTarget.updateMany).toHaveBeenCalledWith({
            where: { hostId: "server", kind: "host" },
            data: { name: "ionos" }
        });
    });

    it("touches no target when the server is not this owner's", async () => {
        host.updateMany.mockResolvedValue({ count: 0 });
        expect(await renameHost("stranger", "server", "ionos")).toBe("missing");
        expect(deployTarget.updateMany).not.toHaveBeenCalled();
    });

    it("reports a name another target holds instead of throwing", async () => {
        host.updateMany.mockResolvedValue({ count: 1 });
        deployTarget.updateMany.mockRejectedValueOnce(
            Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
        );
        expect(await renameHost("owner", "server", "Local")).toBe("taken");
    });

    it("lets any other database failure through", async () => {
        host.updateMany.mockResolvedValue({ count: 1 });
        const failure = Object.assign(new Error("Connection lost"), { code: "P1001" });
        deployTarget.updateMany.mockRejectedValueOnce(failure);
        await expect(renameHost("owner", "server", "ionos")).rejects.toBe(failure);
    });
});
