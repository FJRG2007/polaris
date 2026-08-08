/**
 * Reading an installed app's settings when its service is no longer there.
 *
 * A marketplace app is an InstalledApp row pointing at an ordinary Deploy
 * Application, and the two can come apart: the service is deletable from the
 * Deploy canvas, and a create that fell over can leave the pointer dangling. The
 * settings read used to throw over that, which took down the whole of the app's
 * page - and that page is the only place the Uninstall button lives, so the one
 * install an operator most needed to be rid of was the one they could not open.
 *
 * Hence this: no settings is an answer, not an exception.
 */

import { describe, expect, it, vi } from "vitest";

/** The install row every case here reads, pointing at a service that is gone. */
const install = {
    id: "install-1",
    catalogId: "minecraft",
    ownerId: "owner-1",
    name: "Survival",
    applicationId: "application-gone",
    targetId: null,
    status: "running",
    config: "{}",
    createdAt: new Date("2026-08-08T00:00:00.000Z")
};

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: { findFirst: async () => install },
        // What makes the service "gone": the ownership assertion behind
        // listEnvVars finds nothing and throws, exactly as in production.
        application: { findFirst: async () => null },
        envVar: { findMany: async () => [] }
    }
}));

const { getInstalledAppSettings } = await import("@/lib/apps/install-service");
const { listEnvVars } = await import("@/lib/env-var-service");

describe("getInstalledAppSettings", () => {
    // The precondition: the read underneath really does refuse. Without this the
    // test above could pass because nothing was wired up at all.
    it("is built on a read that refuses a service the owner cannot see", async () => {
        await expect(listEnvVars("application", "application-gone", "owner-1")).rejects.toThrow(
            "Application not found"
        );
    });

    // The property that matters is that it answers at all. What it answers with
    // is the manifest's own defaults, which is what the image would apply anyway.
    it("still answers when the service is gone, so the app's page renders", async () => {
        const settings = await getInstalledAppSettings("owner-1", "install-1");
        expect(settings.length).toBeGreaterThan(0);
        expect(settings.every((setting) => typeof setting.value === "string")).toBe(true);
    });
});
