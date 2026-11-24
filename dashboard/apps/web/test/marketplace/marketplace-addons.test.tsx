// @vitest-environment jsdom

/**
 * Device add-ons on the reader's Marketplace: a kind switch keeps them apart
 * from the apps, their shelf follows the apps', and in a browser - where there
 * is nothing to install them with - the shelf offers the desktop app instead.
 * The Polaris apps screen lists none.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MarketplaceView } from "@/app/(app)/apps/marketplace/marketplace-view";

// The updates a Polaris app card shows are read by a server action.
vi.mock("@/lib/app-bundles/actions", () => ({
    appUpdatesAction: vi.fn(async () => []),
    changeAppBuildAction: vi.fn(async () => ({ rows: [] }))
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
// The template dialog reaches Deploy's server actions; nothing here deploys.
// The template form's login option reads the firewall's actions, which reach the server.
vi.mock("@/app/(app)/apps/firewall/actions", () => ({
    serviceLoginAccessAction: async () => ({}),
    getServiceLoginAction: async () => ({}),
    setServiceLoginAction: async () => ({}),
    findWafPeopleAction: async () => ({ results: [] }),
    listWafPrincipalsAction: async () => ({ principals: [] })
}));
vi.mock("@/app/(app)/apps/deploy/actions", () => ({
    createApplicationAction: vi.fn()
}));
vi.mock("@/app/(app)/apps/marketplace/actions", () => ({
    installAppAction: vi.fn(),
    listStorageConnectionsAction: vi.fn(async () => [])
}));
vi.mock("@/app/(app)/apps/installed/[id]/actions", () => ({
    uninstallInstalledAppAction: vi.fn()
}));

afterEach(cleanup);

describe("device add-ons in the Marketplace", () => {
    it("lists them on a shelf of their own and offers the desktop app in a browser", () => {
        render(<MarketplaceView installed={[]} canInstall />, { wrapper: MessagesWrapper });
        expect(screen.getByRole("radiogroup", { name: "Show" })).toBeTruthy();
        expect(screen.getByRole("region", { name: "Device add-ons" })).toBeTruthy();
        expect(screen.getByRole("link", { name: "Get the desktop app" }).getAttribute("href")).toBe("/account/downloads");
    });

    it("shows only add-ons once Add-ons is picked, and only apps once Apps is", () => {
        render(<MarketplaceView installed={[]} canInstall />, { wrapper: MessagesWrapper });
        const shelves = () => screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"));
        fireEvent.click(screen.getByRole("radio", { name: "Add-ons" }));
        expect(shelves()).toEqual(["Device add-ons"]);
        fireEvent.click(screen.getByRole("radio", { name: "Apps" }));
        expect(shelves()).not.toContain("Device add-ons");
    });

    it("keeps them off the Polaris apps screen", () => {
        render(<MarketplaceView installed={[]} scope="polaris" />, { wrapper: MessagesWrapper });
        expect(screen.queryByRole("radiogroup", { name: "Show" })).toBeNull();
        expect(screen.queryByRole("region", { name: "Device add-ons" })).toBeNull();
    });
});
