// @vitest-environment jsdom

/**
 * Polaris's own optional apps are on the admin marketplace, each wearing its own
 * logo rather than a tinted category glyph, and the Network filter is found by what
 * people call it - a DNS blocker, a Pi-hole - as well as by its name.
 */

import { hasAppLogo } from "@polaris/ui";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appsByCategory, findApp, isInstallable } from "@/lib/apps/catalog";
import { MarketplaceView } from "@/app/(app)/apps/marketplace/marketplace-view";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
// The template dialog reaches Deploy's server actions; nothing here deploys.
vi.mock("@/app/(app)/apps/deploy/actions", () => ({
    listTemplateTargetsAction: vi.fn(async () => []),
    listDeployServersAction: vi.fn(async () => []),
    createApplicationAction: vi.fn()
}));
vi.mock("@/app/(app)/apps/marketplace/actions", () => ({
    installAppAction: vi.fn(),
    listInstallTargetsAction: vi.fn(async () => []),
    listStorageConnectionsAction: vi.fn(async () => [])
}));
vi.mock("@/app/(app)/apps/installed/[id]/actions", () => ({
    uninstallInstalledAppAction: vi.fn()
}));

afterEach(cleanup);

describe("first-party apps on the admin marketplace", () => {
    it("offers the Network filter as an opt-in install, beside the Mail server", () => {
        const offered = appsByCategory().flatMap((group) => group.apps.map((app) => app.id));
        for (const id of ["dns-blocker", "mail-server"]) {
            expect(offered).toContain(id);
            expect(isInstallable(findApp(id)!)).toBe(true);
        }
        // Its engine is installed from inside it, never from the shelf.
        expect(offered).not.toContain("dns-blocker-engine");
    });

    it("draws the Network filter and Status pages with their own logos", () => {
        expect(hasAppLogo("dns-blocker")).toBe(true);
        const { container } = render(<MarketplaceView scope="polaris" installed={[]} />, {
            wrapper: MessagesWrapper
        });
        for (const id of ["dns-blocker", "status-pages", "tools", "calendar"]) {
            expect(container.querySelector(`svg[data-app-logo="${id}"]`), id).not.toBeNull();
        }
    });

    it("finds the Network filter when somebody searches for DNS or Pi-hole", () => {
        render(<MarketplaceView scope="polaris" installed={[]} />, { wrapper: MessagesWrapper });
        const search = screen.getByRole("textbox", { name: "Search apps" });
        for (const term of ["dns", "pi-hole", "adguard", "ad blocker", "adblock", "dns filter"]) {
            fireEvent.change(search, { target: { value: term } });
            expect(screen.getAllByText("Network filter").length, term).toBeGreaterThan(0);
            expect(document.querySelector('svg[data-app-logo="dns-blocker"]'), term).not.toBeNull();
        }
    });
});
