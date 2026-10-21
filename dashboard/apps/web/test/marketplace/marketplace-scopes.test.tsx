// @vitest-environment jsdom

/**
 * Two marketplaces: /apps/marketplace lists other developers' software Polaris
 * deploys, and /admin/apps lists Polaris's own apps beside the ones every
 * Polaris comes with. Neither lists the other's apps, and a built-in app offers
 * no way to remove it.
 */

import { APP_SECTIONS } from "@/lib/apps";
import { MessagesWrapper } from "../setup/i18n";
import { appsByCategory } from "@/lib/apps/catalog";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MarketplaceView } from "@/app/(app)/apps/marketplace/marketplace-view";
import {
    builtInApps,
    listingHref,
    polarisAppsHref,
    storeHome,
    storeScope
} from "@/lib/apps/marketplace-store";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/(app)/apps/marketplace/actions", () => ({
    installAppAction: vi.fn(),
    listInstallTargetsAction: vi.fn(async () => []),
    listStorageConnectionsAction: vi.fn(async () => [])
}));
vi.mock("@/app/(app)/apps/installed/[id]/actions", () => ({
    uninstallInstalledAppAction: vi.fn()
}));

afterEach(cleanup);

const offered = appsByCategory().flatMap((group) => group.apps);
const polarisIds = offered.filter((app) => storeScope(app) === "polaris").map((app) => app.id);

describe("which marketplace lists an app", () => {
    it("puts Polaris's own apps on the admin screen", () => {
        for (const id of ["dns-blocker", "mail-server", "tools", "home", "game-servers"])
            expect(polarisIds, id).toContain(id);
    });

    it("gives each app its page in the marketplace that lists it", () => {
        const calendar = offered.find((app) => app.id === "calendar")!;
        expect(listingHref(calendar)).toBe("/admin/apps/calendar");
        expect(polarisAppsHref("calendar")).toBe("/admin/apps?app=calendar");
        expect(storeHome("deployable")).toBe("/apps/marketplace");
    });

    it("lists the admin screen under Administration, for admins only", () => {
        const entry = APP_SECTIONS.admin.find((section) => section.href === "/admin/apps");
        expect(entry).toMatchObject({ label: "Polaris apps", adminOnly: true });
    });
});

describe("the user marketplace", () => {
    it("lists no Polaris app", () => {
        const { container } = render(<MarketplaceView installed={[]} />, {
            wrapper: MessagesWrapper
        });
        for (const id of polarisIds)
            expect(container.querySelector(`svg[data-app-logo="${id}"]`), id).toBeNull();
        expect(screen.queryByText("Ad blocker")).toBeNull();
    });

    it("says so when it has nothing, and points an admin to Polaris apps", () => {
        render(<MarketplaceView installed={[]} canBrowsePolaris />, { wrapper: MessagesWrapper });
        expect(screen.getByText("Nothing to deploy yet")).toBeTruthy();
        expect(screen.getByRole("link", { name: "Open Polaris apps" }).getAttribute("href")).toBe(
            "/admin/apps"
        );
        // Nothing to search through, so no search box.
        expect(screen.queryByRole("textbox", { name: "Search apps" })).toBeNull();
    });

    it("offers no link to the admin screen to anybody else", () => {
        render(<MarketplaceView installed={[]} />, { wrapper: MessagesWrapper });
        expect(screen.getByText("Nothing to deploy yet")).toBeTruthy();
        expect(screen.queryByRole("link", { name: "Open Polaris apps" })).toBeNull();
    });
});

describe("the admin marketplace", () => {
    it("lists Polaris's apps under its own title", () => {
        const { container } = render(<MarketplaceView scope="polaris" installed={[]} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByRole("heading", { name: "Polaris apps", level: 1 })).toBeTruthy();
        expect(container.querySelector('svg[data-app-logo="dns-blocker"]')).not.toBeNull();
    });

    it("lists the apps every Polaris comes with, with nothing to uninstall", () => {
        expect(builtInApps().map((app) => app.id)).toEqual(
            expect.arrayContaining(["drive", "chat", "tasks", "mail", "notes"])
        );
        expect(builtInApps().map((app) => app.id)).not.toContain("admin");
        render(<MarketplaceView scope="polaris" installed={[]} canInstall />, {
            wrapper: MessagesWrapper
        });
        const section = screen.getByRole("region", { name: "Built in" });
        const rows = section.querySelectorAll("[data-built-in]");
        expect(rows.length).toBe(builtInApps().length);
        for (const row of rows) {
            expect(within(row as HTMLElement).queryAllByRole("button")).toEqual([]);
            expect(within(row as HTMLElement).getAllByText("Built in").length).toBeGreaterThan(0);
            expect(within(row as HTMLElement).getByRole("link", { name: "Open" })).toBeTruthy();
        }
        expect(within(section).queryByText(/uninstall/i)).toBeNull();
    });

    it("keeps the user marketplace's apps off the built-in list", () => {
        render(<MarketplaceView installed={[]} />, { wrapper: MessagesWrapper });
        expect(screen.queryByRole("region", { name: "Built in" })).toBeNull();
    });
});
