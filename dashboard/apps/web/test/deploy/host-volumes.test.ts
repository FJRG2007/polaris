/**
 * Removing a volume when Polaris cannot read its own records.
 *
 * What is pinned: an owner lookup that fails refuses the removal rather than
 * reading as "no owner", and the daemon is never asked to delete anything; the
 * listing a screen reads still answers with what it could find.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
    fail: false,
    deletes: [] as string[]
}));

vi.mock("@polaris/db", () => {
    const table = () => ({
        findMany: async () => {
            if (fake.fail) throw new Error("database unavailable");
            return [];
        },
        upsert: async () => ({}),
        updateMany: async () => ({ count: 0 })
    });
    return {
        prisma: {
            volume: table(),
            application: table(),
            managedDatabase: table(),
            hostResourceRecord: table(),
            $transaction: async () => []
        }
    };
});

vi.mock("@polaris/hostd-client", () => ({
    HostdClient: class {
        async dockerRequest(method: string, path: string) {
            if (method === "DELETE") {
                fake.deletes.push(path);
                return { status: 204, body: "" };
            }
            const volume = {
                Name: "polaris-36e74d11_data",
                CreatedAt: "2026-01-01T00:00:00Z",
                Labels: { "com.docker.compose.project": "polaris-36e74d11" },
                UsageData: { Size: 1024, RefCount: 0 }
            };
            if (path === "/volumes") return { status: 200, body: JSON.stringify({ Volumes: [volume] }) };
            if (path === "/system/df") return { status: 200, body: JSON.stringify({ Volumes: [volume] }) };
            return { status: 200, body: "[]" };
        }
    }
}));

const { hostVolumes, removeHostVolume } = await import("@/lib/deploy/host-volumes");

beforeEach(() => {
    fake.fail = false;
    fake.deletes = [];
});

describe("removing a volume whose owner cannot be read", () => {
    it("refuses, and asks the daemon for nothing", async () => {
        fake.fail = true;
        const result = await removeHostVolume("polaris-36e74d11_data");
        expect(result.ok).toBe(false);
        expect(fake.deletes).toEqual([]);
    });

    it("fails a strict listing instead of calling everything ownerless", async () => {
        fake.fail = true;
        await expect(hostVolumes({ strict: true })).rejects.toThrow();
    });

    it("still lists for a screen", async () => {
        fake.fail = true;
        expect((await hostVolumes())?.map((volume) => volume.name)).toEqual(["polaris-36e74d11_data"]);
    });

    it("removes it when the records say nobody owns it", async () => {
        expect(await removeHostVolume("polaris-36e74d11_data")).toEqual({ ok: true });
        expect(fake.deletes).toEqual(["/volumes/polaris-36e74d11_data"]);
    });
});
