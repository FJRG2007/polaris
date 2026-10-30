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
        expect(await renameHost("owner", "server", "ionos")).toBe(true);
        expect(deployTarget.updateMany).toHaveBeenCalledWith({
            where: { hostId: "server", kind: "host" },
            data: { name: "ionos" }
        });
    });

    it("touches no target when the server is not this owner's", async () => {
        host.updateMany.mockResolvedValue({ count: 0 });
        expect(await renameHost("stranger", "server", "ionos")).toBe(false);
        expect(deployTarget.updateMany).not.toHaveBeenCalled();
    });
});
