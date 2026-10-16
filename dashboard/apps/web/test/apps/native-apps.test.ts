/**
 * Security scans and Cloud servers are part of every Polaris: present without
 * an install, never offered or installable from the marketplace, never
 * uninstallable, and an install row left from before keeps working and stays
 * out of every list of installed apps.
 */

import { describe, expect, it, vi } from "vitest";

const queries: unknown[] = [];
vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findFirst: async () => {
                throw new Error("a native app is present without asking the database");
            },
            findMany: async (query: unknown) => {
                queries.push(query);
                return [];
            }
        }
    }
}));
vi.mock("@/lib/i18n/reader-words", () => ({
    readerWords: async () => (key: string) => key
}));

const native = await import("@/lib/apps/native-apps");
const catalog = await import("@/lib/apps/catalog");
const { isAppInstalled } = await import("@/lib/apps/install-presence");
const { appUninstallRefusal } = await import("@/lib/apps/app-lifecycle");
const { listInstalledApps } = await import("@/lib/apps/install-service");
const { SETUP_APPS } = await import("@/lib/setup/setup-wizard");

const IDS = ["security-scans", "cloud-servers"] as const;

describe("native apps", () => {
    it("are exactly Security scans and Cloud servers, each at its Servers section", () => {
        expect(native.NATIVE_APPS).toEqual({
            "security-scans": "/apps/servers/security",
            "cloud-servers": "/apps/servers/cloud"
        });
        expect(native.NATIVE_APP_IDS).toEqual([...IDS]);
        expect(native.isNativeApp("calendar")).toBe(false);
        expect(native.isNativeApp("toString")).toBe(false);
    });

    it("are present on a Polaris that never installed them", async () => {
        for (const id of IDS) await expect(isAppInstalled(id)).resolves.toBe(true);
    });

    it("are not offered, listed or installable in the marketplace", () => {
        const offered = catalog.appsByCategory().flatMap((group) => group.apps.map((app) => app.id));
        const installable = catalog.installableApps().map((app) => app.id);
        for (const id of IDS) {
            const app = catalog.findApp(id);
            expect(app, id).toBeDefined();
            expect(catalog.isOffered(app!)).toBe(false);
            expect(catalog.isInstallable(app!)).toBe(false);
            expect(offered).not.toContain(id);
            expect(installable).not.toContain(id);
            // An old install's Open, and its marketplace page, go to the section.
            expect(app!.opensAt).toBe(native.NATIVE_APPS[id]);
        }
    });

    it("are not recommended by the setup wizard", () => {
        for (const id of IDS) expect(SETUP_APPS as readonly string[]).not.toContain(id);
    });

    it("refuse to be uninstalled, in words", async () => {
        for (const id of IDS) {
            await expect(
                appUninstallRefusal({ id: "row-1", catalogId: id, ownerId: "owner-1" })
            ).resolves.toBe("refusals.apps.native");
        }
        await expect(
            appUninstallRefusal({ id: "row-2", catalogId: "calendar", ownerId: "owner-1" })
        ).resolves.toBeNull();
    });

    it("leave a row from before out of the installed list, on both sides of a grant", async () => {
        queries.length = 0;
        await listInstalledApps("owner-1", ["granted-1"]);
        const [query] = queries as { where: { OR: Record<string, unknown>[] } }[];
        for (const branch of query!.where.OR) {
            expect(branch.catalogId).toEqual({ notIn: [...IDS] });
            expect(branch.status).toEqual({ not: "removed" });
        }
    });
});
