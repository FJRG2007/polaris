/**
 * Installing a Polaris app is an administrator's act, on the server too.
 *
 * The admin marketplace is the only screen that offers one, but the install
 * action is reachable from any page, so the action itself refuses a caller
 * without the admin flag - while an app from other developers stays open to
 * anyone holding deploy.manage.
 */

import { findApp } from "@/lib/apps/catalog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storeApps, storeScope } from "@/lib/apps/marketplace-store";

const USER = { id: "00000000-0000-7000-8000-00000000000c" };

let admin = false;

class Denied extends Error {}

vi.mock("@/lib/session", () => ({
    requirePermission: async () => USER,
    requireAdmin: async () => {
        if (!admin) throw new Denied("not an admin");
        return USER;
    }
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/host-service", () => ({ listHosts: async () => [] }));
vi.mock("@/lib/storage-service", () => ({ listConnections: async () => [] }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
const installApp = vi.hoisted(() => vi.fn(async () => ({ installedAppId: "installed-1" })));
vi.mock("@/lib/apps/install-service", () => ({ installApp, listInstalledApps: async () => [] }));

const { installAppAction } = await import("@/app/(app)/apps/marketplace/actions");

/** The first catalog app in the given marketplace. */
function catalogApp(scope: "polaris" | "deployable"): string {
    const app = storeApps().find((entry) => storeScope(entry) === scope && findApp(entry.id));
    if (!app) throw new Error(`no ${scope} catalog app`);
    return app.id;
}

function install(catalogId: string) {
    return installAppAction({
        catalogId,
        name: "Instance",
        serverId: "local",
        storage: [],
        env: []
    });
}

beforeEach(() => {
    admin = false;
    installApp.mockClear();
});

describe("installing from the marketplace", () => {
    it("refuses a Polaris app to a caller who is not an administrator", async () => {
        await expect(install(catalogApp("polaris"))).rejects.toBeInstanceOf(Denied);
        expect(installApp).not.toHaveBeenCalled();
    });

    it("installs a Polaris app for an administrator", async () => {
        admin = true;
        await expect(install(catalogApp("polaris"))).resolves.toEqual({
            installedAppId: "installed-1"
        });
    });

    it("installs another developer's app with deploy.manage alone", async () => {
        await expect(install(catalogApp("deployable"))).resolves.toEqual({
            installedAppId: "installed-1"
        });
    });
});
