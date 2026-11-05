/**
 * The router screen opens on the first machine Polaris holds root on, found
 * with bounded reads; the picker pages the rest.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const findMany = vi.fn();
vi.mock("@polaris/db", () => ({
    prisma: {
        host: {
            findFirst: (...args: unknown[]) => findFirst(...args),
            findMany: (...args: unknown[]) => findMany(...args)
        }
    }
}));
vi.mock("@/lib/setting-store", () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));
vi.mock("@/lib/host-service", () => ({ getHostConnection: vi.fn() }));
vi.mock("@/lib/deploy/server-edge", () => ({ edgeLauncher: vi.fn() }));
vi.mock("@polaris/ssh", () => ({ execCommand: vi.fn(), openSshClient: vi.fn() }));

const { routerStart } = await import("@/lib/router/service");

const ROOT = { id: "host-1", name: "edge", address: "10.0.0.1" };

beforeEach(() => {
    findFirst.mockReset();
    findMany.mockReset();
});

describe("routerStart", () => {
    it("opens on the first root machine of the owner, never listing them", async () => {
        findFirst.mockResolvedValueOnce({ id: "host-0" }).mockResolvedValueOnce(ROOT);
        expect(await routerStart("owner-1")).toEqual({
            hasMachines: true,
            first: { ...ROOT, root: true }
        });
        expect(findMany).not.toHaveBeenCalled();
        const [, rootRead] = findFirst.mock.calls.map(([args]) => args);
        expect(rootRead.where).toEqual({
            ownerId: "owner-1",
            OR: [{ sudo: true }, { username: "root" }]
        });
        expect(rootRead.orderBy).toEqual([{ name: "asc" }, { id: "asc" }]);
    });

    it("tells a machine without root apart from no machine at all", async () => {
        findFirst.mockResolvedValueOnce({ id: "host-0" }).mockResolvedValueOnce(null);
        expect(await routerStart("owner-1")).toEqual({ hasMachines: true, first: null });
        findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
        expect(await routerStart("owner-1")).toEqual({ hasMachines: false, first: null });
    });
});
