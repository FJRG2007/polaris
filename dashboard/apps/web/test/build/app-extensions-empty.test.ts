/**
 * Core with no installable app present.
 *
 * What a server that installed nothing will run once apps ship as bundles: the
 * registry answers nothing, and every core path that asks it still works - no
 * app jobs, no app backup sources (a stored resource of an app's kind reads as
 * unavailable rather than breaking the backup engine), the stored image is left
 * alone, and no ports, panels or firewall sections appear.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/app-extensions/installed", () => ({ installedExtensions: () => [] }));
vi.mock("@/lib/apps/install-presence", () => ({ isAppInstalled: async () => true }));

const registry = await import("@/lib/app-extensions/registry");

describe("the app extension registry with nothing installed", () => {
    it("runs no app jobs", () => {
        expect(registry.appJobs()).toEqual([]);
    });

    it("provides no backup sources", () => {
        expect(registry.appBackupSource("minecraft-world")).toBeNull();
        expect(registry.appBackupSources()).toEqual([]);
    });

    it("leaves a release on the image it was stored with", () => {
        expect(registry.releaseImageFor("itzg/minecraft-server:latest", { VERSION: "1.21" })).toBe(
            "itzg/minecraft-server:latest"
        );
    });

    it("has no opinion about plugin servers", () => {
        expect(registry.isPluginServer("minecraft", new Map([["TYPE", "PAPER"]]))).toBeNull();
    });

    it("draws nothing and forwards nothing", async () => {
        expect(await registry.gameServerSummaries("user")).toEqual([]);
        expect(await registry.forwardedPorts()).toEqual([]);
        expect(await registry.readForwardedPorts(false)).toBeNull();
        expect(await registry.firewallSlot("owner", "app")).toBeNull();
        expect(
            await registry.installedPanelSlot({
                id: "install",
                catalogId: "minecraft",
                applicationId: null,
                ownerId: "owner"
            })
        ).toBeNull();
        await expect(registry.beforeInstallStops("owner", "install")).resolves.toBeUndefined();
        await expect(registry.afterInstallStarts("install")).resolves.toBeUndefined();
        await expect(registry.adoptAppInstalls("owner")).resolves.toBeUndefined();
        expect(() => registry.bootApps()).not.toThrow();
        expect(await registry.appReaches("home", "user")).toBe(false);
    });
});

describe("the backup engine with nothing installed", () => {
    it("reads an app's resource kind as unavailable instead of failing to load", async () => {
        const { sourceFor, allSources } = await import("@/lib/backups/sources/registry");
        const source = sourceFor("minecraft-world");
        expect(await source.discover("owner")).toEqual([]);
        await expect(
            source.produce({
                id: "r",
                ownerId: "owner",
                kind: "minecraft-world",
                selector: "minecraft-world:x",
                name: "World",
                config: {}
            })
        ).rejects.toThrow(/not installed/);
        expect(allSources().some((entry) => entry.kind === "minecraft-world")).toBe(false);
    });
});

describe("a job that belongs to an app", () => {
    it("does nothing while the app is not installed", async () => {
        const run = vi.fn(async () => "ran");
        const presence = await import("@/lib/apps/install-presence");
        vi.spyOn(presence, "isAppInstalled").mockResolvedValueOnce(false);
        const guarded = registry.whileInstalled("game-servers", run);
        expect(await guarded()).toEqual({ skipped: "game-servers is not installed" });
        expect(run).not.toHaveBeenCalled();
    });
});
