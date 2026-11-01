/** A machine taken out of Polaris takes its router plan with it, and only its owner's
 *  removal does. */

import { afterEach, describe, expect, it, vi } from "vitest";

const deleteMany = vi.fn();
const setSetting = vi.fn(async () => undefined);
vi.mock("@polaris/db", () => ({ prisma: { host: { deleteMany } } }));
vi.mock("@/lib/setting-store", () => ({ setSetting }));
vi.mock("@/lib/access/grants", () => ({ dropGrantsFor: vi.fn(async () => undefined) }));
vi.mock("@/lib/connection-pool", () => ({ dropSshConnections: vi.fn() }));

const { deleteHost } = await import("@/lib/host-service");

const HOST = "0190f1c2-0000-7000-8000-00000000000a";

afterEach(() => vi.clearAllMocks());

describe("removing a machine", () => {
    it("deletes its router plan", async () => {
        deleteMany.mockResolvedValue({ count: 1 });
        await deleteHost("owner", HOST);
        expect(setSetting).toHaveBeenCalledWith(`router.plan.${HOST}`, null);
    });

    it("leaves the plan of a machine that was not the caller's", async () => {
        deleteMany.mockResolvedValue({ count: 0 });
        await deleteHost("someone else", HOST);
        expect(setSetting).not.toHaveBeenCalled();
    });
});
