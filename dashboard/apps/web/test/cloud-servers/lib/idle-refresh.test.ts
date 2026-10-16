/**
 * Cloud servers is part of every Polaris, so its hourly refresh runs on
 * instances that never connected a cloud account. With no server created here
 * it reads one table and calls no provider.
 */

import { describe, expect, it, vi } from "vitest";

const reads: string[] = [];
vi.mock("@polaris/db", () => ({
    prisma: {
        cloudServer: {
            findMany: async () => {
                reads.push("cloudServer.findMany");
                return [];
            },
            update: async () => {
                throw new Error("nothing to update on an idle instance");
            }
        }
    }
}));

const dialled = vi.hoisted(() => [] as string[]);
vi.mock("@polaris-app/cloud-servers/src/lib/providers", () => ({
    adapterFor: () => {
        dialled.push("adapterFor");
        throw new Error("no provider should be called on an idle instance");
    }
}));

vi.mock("@polaris/app-host", () => ({ host: new Proxy({}, { get: () => () => undefined }) }));

const { refreshAll } = await import("@polaris-app/cloud-servers/src/lib/service");

describe("cloud servers refresh with nothing created", () => {
    it("reads the server list once and calls no provider", async () => {
        await expect(refreshAll()).resolves.toEqual({ read: 0, failed: 0 });
        expect(reads).toEqual(["cloudServer.findMany"]);
        expect(dialled).toEqual([]);
    });
});
