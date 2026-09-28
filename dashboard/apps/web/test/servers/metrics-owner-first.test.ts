/**
 * A server's readings are its owner's, from memory as much as from a probe.
 *
 * Readings are cached for a few seconds so a polling dashboard does not open an
 * SSH session on every tick. The ownership check used to sit after that cache,
 * so anybody who named another owner's server id within the window was answered
 * with its figures. The check now comes first.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const hostCount = vi.fn(async (_args: unknown) => 1);
const getHostConnection = vi.fn(async () => ({
    address: "192.0.2.10",
    port: 22,
    username: "root",
    auth: {}
}));
const borrowSsh = vi.fn(async () => ({ client: {}, release: () => undefined }));
const execCommand = vi.fn(
    async (_client: unknown, _command: string, options: { onStdout: (chunk: Buffer) => void }) => {
        options.onStdout(Buffer.from(""));
    }
);

vi.mock("@polaris/db", () => ({ prisma: { host: { count: hostCount } } }));
vi.mock("@polaris/ssh", () => ({ execCommand }));
vi.mock("@/lib/connection-pool", () => ({ borrowSsh }));
vi.mock("@/lib/host-service", () => ({ getHostConnection }));
vi.mock("@/lib/server-probe", () => ({ PROBE: "", parseProbe: () => ({ os: "test" }) }));

const { getServerMetrics } = await import("../../src/lib/server-metrics-service");

beforeEach(() => {
    vi.clearAllMocks();
    hostCount.mockResolvedValue(1);
});

describe("getServerMetrics", () => {
    it("refuses a server that is not the caller's, even with a fresh reading in memory", async () => {
        // The owner's poll fills the cache.
        await getServerMetrics("host-1", "owner").catch(() => null);

        hostCount.mockResolvedValue(0);
        await expect(getServerMetrics("host-1", "somebody-else")).rejects.toThrow("Host not found");
        expect(hostCount).toHaveBeenLastCalledWith({
            where: { id: "host-1", ownerId: "somebody-else" }
        });
    });
});
