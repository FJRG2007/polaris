// @vitest-environment jsdom

/**
 * Two marketplaces: /apps/marketplace lists other developers' software Polaris
 * deploys, and /admin/apps lists Polaris's own apps beside the ones every
 * Polaris comes with. Neither lists the other's apps, and a built-in app offers
 * no way to remove it.
 */

import { APP_SECTIONS } from "@/lib/apps";
import { MessagesWrapper } from "../setup/i18n";
import { SERVICE_TEMPLATES } from "@polaris/core";
import { appsByCategory } from "@/lib/apps/catalog";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketplaceView } from "@/app/(app)/apps/marketplace/marketplace-view";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
    builtInApps,
    findStoreApp,
    listingHref,
    primaryAction,
    polarisAppsHref,
    storeHome,
    storeScope
} from "@/lib/apps/marketplace-store";

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
        expect(screen.queryByRole("region", { name: "Polaris apps" })).toBeNull();
    });

    it("lists every Deploy template, read from Deploy's own list, and OpenClaw and Hermes", () => {
        render(<MarketplaceView installed={[]} canInstall />, { wrapper: MessagesWrapper });
        const shelf = screen.getByRole("region", { name: "From other developers" });
        for (const template of SERVICE_TEMPLATES)
            expect(
                within(shelf).getAllByRole("link", { name: template.name }).length,
                template.id
            ).toBeGreaterThan(0);
        for (const name of ["OpenClaw assistant", "Hermes assistant"])
            expect(within(shelf).getAllByRole("link", { name }).length, name).toBeGreaterThan(0);
    });

    it("searches the templates and the wrapped apps together", () => {
        render(<MarketplaceView installed={[]} canInstall />, { wrapper: MessagesWrapper });
        const search = screen.getByRole("textbox", { name: "Search apps" });
        fireEvent.change(search, { target: { value: "n8n" } });
        expect(screen.getAllByRole("link", { name: "n8n" }).length).toBeGreaterThan(0);
        expect(screen.queryByRole("link", { name: "OpenClaw assistant" })).toBeNull();
        fireEvent.change(search, { target: { value: "openclaw" } });
        expect(screen.getAllByRole("link", { name: "OpenClaw assistant" }).length).toBeGreaterThan(
            0
        );
        expect(screen.queryByRole("link", { name: "n8n" })).toBeNull();
    });

    it("files each template under a store category, Tools when it has none of its own", () => {
        expect(findStoreApp("template-n8n")?.category).toBe("Productivity");
        expect(findStoreApp("template-open-webui")?.category).toBe("AI");
        expect(findStoreApp("template-kafka")?.category ?? "Tools").toBe("Tools");
        expect(findStoreApp("template-no-such-template")).toBeUndefined();
    });

    it("leads a template with Deploy, and an announced wrapped app with Coming soon", () => {
        expect(
            primaryAction(findStoreApp("template-n8n")!, {
                installs: [],
                canInstall: true,
                installing: false
            })
        ).toEqual({ kind: "deploy" });
        expect(
            primaryAction(findStoreApp("template-n8n")!, {
                installs: [],
                canInstall: false,
                installing: false
            })
        ).toEqual({ kind: "locked" });
        expect(
            primaryAction(findStoreApp("openclaw")!, {
                installs: [],
                canInstall: true,
                installing: false
            })
        ).toEqual({ kind: "comingSoon" });
        expect(storeScope(findStoreApp("hermes")!)).toBe("deployable");
        expect(listingHref(findStoreApp("template-n8n")!)).toBe("/apps/marketplace/template-n8n");
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
            expect(within(row as HTMLElement).getByRole("link", { name: "Open" })).toBeTruthy();
        }
        expect(within(section).queryByText(/uninstall/i)).toBeNull();
    });

    it("lists no Deploy template or wrapped app", () => {
        render(<MarketplaceView scope="polaris" installed={[]} />, { wrapper: MessagesWrapper });
        expect(screen.queryByRole("link", { name: "n8n" })).toBeNull();
        expect(screen.queryByRole("link", { name: "OpenClaw assistant" })).toBeNull();
    });

    it("keeps the user marketplace's apps off the built-in list", () => {
        render(<MarketplaceView installed={[]} />, { wrapper: MessagesWrapper });
        expect(screen.queryByRole("region", { name: "Built in" })).toBeNull();
    });
});
