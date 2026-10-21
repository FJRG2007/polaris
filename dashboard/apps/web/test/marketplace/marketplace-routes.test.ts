/**
 * Old links keep working after the split: a Polaris app named in the user
 * marketplace opens on the admin screen, another developer's app named on the
 * admin screen opens in the user marketplace, and the admin screen asks for an
 * admin before it reads anything.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ admin: true }));

vi.mock("next/navigation", () => ({
    notFound: () => {
        throw new Error("not found");
    },
    redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
    }
}));
vi.mock("@/lib/session", () => ({
    requirePermission: vi.fn(async () => ({ id: "reader-1", isAdmin: false })),
    requireAdmin: vi.fn(async () => {
        if (!session.admin) throw new Error("redirect /home?denied=1");
        return { id: "admin-1", isAdmin: true };
    }),
    sessionCan: vi.fn(async () => true)
}));
vi.mock("@/lib/app-extensions/registry", () => ({ adoptAppInstalls: vi.fn(async () => {}) }));
vi.mock("@/lib/mail-server/app-install", () => ({ adoptMailServerApp: vi.fn(async () => {}) }));
vi.mock("@/lib/apps/install-access", () => ({ uninstallAccess: vi.fn(async () => null) }));
vi.mock("@/lib/apps/install-service", () => ({
    installForReader: vi.fn(),
    instanceWideInstallIds: vi.fn(async () => []),
    listInstalledApps: vi.fn(async () => [])
}));
vi.mock("@/app/(app)/apps/marketplace/marketplace-view", () => ({ MarketplaceView: () => null }));
vi.mock("@/app/(app)/apps/marketplace/[appId]/app-detail", () => ({
    AppDetail: () => null,
    AppInstallPanel: () => null,
    AppInstallPanelSkeleton: () => null
}));

const { default: MarketplacePage } = await import("@/app/(app)/apps/marketplace/page");
const { default: MarketplaceAppPage } = await import("@/app/(app)/apps/marketplace/[appId]/page");
const { default: PolarisAppsPage } = await import("@/app/(app)/admin/apps/page");
const { default: PolarisAppPage } = await import("@/app/(app)/admin/apps/[appId]/page");

const query = (app?: string) => ({ searchParams: Promise.resolve(app ? { app } : {}) });
const page = (appId: string) => ({ params: Promise.resolve({ appId }) });

beforeEach(() => {
    session.admin = true;
});

describe("a link to a Polaris app in the user marketplace", () => {
    it("opens the admin screen on it", async () => {
        await expect(MarketplacePage(query("dns-blocker"))).rejects.toThrow(
            "redirect /admin/apps?app=dns-blocker"
        );
    });

    it("opens its page on the admin screen", async () => {
        await expect(MarketplaceAppPage(page("mail-server"))).rejects.toThrow(
            "redirect /admin/apps/mail-server"
        );
    });

    it("leaves the grid alone when it names no app", async () => {
        await expect(MarketplacePage(query())).resolves.toBeTruthy();
    });
});

describe("the admin screen", () => {
    it("is for admins only, the grid and an app's page alike", async () => {
        session.admin = false;
        await expect(PolarisAppsPage(query())).rejects.toThrow("denied");
        await expect(PolarisAppPage(page("calendar"))).rejects.toThrow("denied");
    });

    it("draws a Polaris app's page", async () => {
        await expect(PolarisAppPage(page("calendar"))).resolves.toBeTruthy();
        await expect(PolarisAppsPage(query("calendar"))).resolves.toBeTruthy();
    });

    it("answers an app it does not list with not found", async () => {
        await expect(PolarisAppPage(page("no-such-app"))).rejects.toThrow("not found");
        // A helper another app runs is not listed on its own.
        await expect(PolarisAppPage(page("dns-blocker-engine"))).rejects.toThrow("not found");
    });
});
