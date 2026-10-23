// @vitest-environment jsdom

/**
 * The store listing as drawn: a real capture or the designed placeholder on
 * each card, the category chips, and the one action a card leads with for a
 * reader who may install and for one who may not.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppDetail } from "@/app/(app)/apps/marketplace/[appId]/app-detail";
import { MarketplaceView } from "@/app/(app)/apps/marketplace/marketplace-view";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

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

/** The card whose name links to this app's page. */
function cardOf(name: string): HTMLElement {
    const shelf = screen.getByRole("region", { name: "Polaris apps" });
    return within(shelf).getByRole("link", { name }).closest("article") as HTMLElement;
}

describe("the store listing", () => {
    it("shows a real capture where one exists and the placeholder where none does", () => {
        render(<MarketplaceView scope="polaris" installed={[]} />, { wrapper: MessagesWrapper });
        const calendar = cardOf("Calendar");
        expect(
            calendar.querySelector('img[src="/marketplace/calendar-dark-en-desktop.webp"]')
        ).not.toBeNull();
        expect(calendar.querySelector('[data-preview="placeholder"]')).toBeNull();
        const bridge = cardOf("Messaging bridge");
        expect(bridge.querySelector("img")).toBeNull();
        expect(bridge.querySelector('[data-preview="placeholder"]')).not.toBeNull();
    });

    it("features only apps with a capture", () => {
        render(<MarketplaceView scope="polaris" installed={[]} />, { wrapper: MessagesWrapper });
        const featured = screen.getByRole("region", { name: "Featured" });
        expect(within(featured).getByRole("link", { name: "Calendar" })).toBeTruthy();
        expect(within(featured).queryByRole("link", { name: "Messaging bridge" })).toBeNull();
    });

    it("filters by the category chip pressed, and hides the featured row while filtered", () => {
        render(<MarketplaceView scope="polaris" installed={[]} />, { wrapper: MessagesWrapper });
        const chips = screen.getByRole("group", { name: "Categories" });
        const games = within(chips).getByRole("button", { name: "Game servers" });
        fireEvent.click(games);
        expect(games.getAttribute("aria-pressed")).toBe("true");
        expect(screen.queryByRole("region", { name: "Featured" })).toBeNull();
        expect(screen.queryByRole("link", { name: "Calendar" })).toBeNull();
        expect(screen.getAllByRole("link", { name: "Game servers" }).length).toBeGreaterThan(0);
    });

    it("leads with Install for a reader who may, and says why for one who may not", () => {
        const { unmount } = render(<MarketplaceView scope="polaris" installed={[]} canInstall />, {
            wrapper: MessagesWrapper
        });
        expect(within(cardOf("CRM")).getByRole("button", { name: "Install" })).toBeTruthy();
        unmount();
        render(<MarketplaceView scope="polaris" installed={[]} />, { wrapper: MessagesWrapper });
        const crm = cardOf("CRM");
        expect(within(crm).queryByRole("button", { name: "Install" })).toBeNull();
        const locked = within(crm).getByRole("button", { name: /Needs permission/ });
        expect(locked.getAttribute("aria-disabled")).toBe("true");
        expect((locked as HTMLButtonElement).disabled).toBe(false);
        expect(locked.getAttribute("title")).toMatch(/Ask an admin/);
    });

    it("leads with Open for an app this Polaris already has", () => {
        render(
            <MarketplaceView
                scope="polaris"
                installed={[
                    {
                        id: "install-1",
                        catalogId: "crm",
                        name: "CRM",
                        status: "stopped",
                        applicationId: null,
                        createdAt: new Date("2026-01-01").toISOString()
                    }
                ]}
            />,
            { wrapper: MessagesWrapper }
        );
        const open = within(cardOf("CRM")).getByRole("link", { name: "Open" });
        expect(open.getAttribute("href")).toBe("/crm");
        expect(within(cardOf("CRM")).getByText("Installed")).toBeTruthy();
    });
});

describe("an app's page without captures", () => {
    it("shows the designed preview and no screenshot gallery", () => {
        render(
            <AppDetail appId="messaging-bridge">
                <div />
            </AppDetail>,
            { wrapper: MessagesWrapper }
        );
        expect(document.querySelector('[data-preview="placeholder"]')).not.toBeNull();
        expect(screen.queryByRole("group", { name: "Screenshots" })).toBeNull();
        expect(screen.getByText(/needs permission to manage apps/)).toBeTruthy();
    });

    it("pages the gallery with the arrow keys", () => {
        render(
            <AppDetail appId="game-servers">
                <div />
            </AppDetail>,
            { wrapper: MessagesWrapper }
        );
        const strip = screen.getByRole("group", { name: "Screenshots" });
        expect(screen.getByText("1 of 5")).toBeTruthy();
        fireEvent.keyDown(strip, { key: "ArrowRight" });
        expect(screen.getByText("2 of 5")).toBeTruthy();
        fireEvent.keyDown(strip, { key: "ArrowLeft" });
        fireEvent.keyDown(strip, { key: "ArrowLeft" });
        expect(screen.getByText("1 of 5")).toBeTruthy();
    });

    it("follows the strip when it is swiped instead of paged", () => {
        render(
            <AppDetail appId="game-servers">
                <div />
            </AppDetail>,
            { wrapper: MessagesWrapper }
        );
        const strip = screen.getByRole("group", { name: "Screenshots" });
        const figures = Array.from(strip.children) as HTMLElement[];
        const rect = (left: number) => ({ left }) as DOMRect;
        strip.getBoundingClientRect = () => rect(0);
        Object.defineProperty(strip, "clientWidth", { value: 500, configurable: true });
        Object.defineProperty(strip, "scrollWidth", { value: 2000, configurable: true });
        figures.forEach((figure, index) => {
            figure.getBoundingClientRect = () => rect(index * 400 - 800);
        });
        strip.scrollLeft = 800;
        fireEvent.scroll(strip);
        expect(screen.getByText("3 of 5")).toBeTruthy();
        strip.scrollLeft = 1500;
        fireEvent.scroll(strip);
        expect(screen.getByText("5 of 5")).toBeTruthy();
    });
});
