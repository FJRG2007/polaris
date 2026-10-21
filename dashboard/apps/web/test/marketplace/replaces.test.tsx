// @vitest-environment jsdom

/**
 * What an app replaces: every entry names an app that exists, every logo is a
 * README tile the app serves unchanged, and an app's store page and built-in
 * row draw the row - and nothing where there is nothing to list.
 */

import { resolve } from "node:path";
import { MessagesWrapper } from "../setup/i18n";
import { builtInApps, findStoreApp } from "@/lib/apps/marketplace-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cleanup, render, screen, within } from "@testing-library/react";
import { AppDetail } from "@/app/(app)/apps/marketplace/[appId]/app-detail";
import { MarketplaceView } from "@/app/(app)/apps/marketplace/marketplace-view";
import { APP_REPLACES, appReplaces, replacedLogoSrc } from "@/lib/apps/replaces";

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

const SERVED = resolve(__dirname, "../../public/logos/brands");
const README_LOGOS = resolve(__dirname, "../../../../../docs/assets/logos");
const entries = Object.entries(APP_REPLACES);
const logos = new Set(entries.flatMap(([, items]) => items.map((item) => item.logo)));

describe("the replaces table", () => {
    it("names only apps that exist: a marketplace app, a Deploy template or a built-in one", () => {
        const builtIn = new Set(builtInApps().map((app) => app.id));
        for (const [id] of entries) {
            const app = findStoreApp(id);
            expect(builtIn.has(id) || (app !== undefined && !app.internal), id).toBe(true);
        }
    });

    it("lists each product once per app, and nothing empty", () => {
        for (const [id, items] of entries) {
            expect(items.length, id).toBeGreaterThan(0);
            expect(new Set(items.map((item) => item.name)).size, id).toBe(items.length);
        }
    });

    it("serves every logo, byte for byte the README's tile", () => {
        for (const logo of logos) {
            const served = resolve(SERVED, `${logo}.svg`);
            const readme = resolve(README_LOGOS, `${logo}.svg`);
            expect(existsSync(served), served).toBe(true);
            expect(existsSync(readme), readme).toBe(true);
            expect(readFileSync(served).equals(readFileSync(readme)), logo).toBe(true);
        }
    });

    it("serves no tile nothing lists", () => {
        const files = readdirSync(SERVED).map((file) => file.replace(/\.svg$/, ""));
        expect(files.sort()).toEqual([...logos].sort());
    });

    it("is empty for an app with nothing to list", () => {
        expect(appReplaces("tools")).toEqual([]);
        expect(appReplaces("no-such-app")).toEqual([]);
    });
});

describe("an app's store page", () => {
    it("draws what it replaces, each logo named", () => {
        render(
            <AppDetail appId="calendar">
                <div />
            </AppDetail>,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByRole("heading", { name: "Replaces" })).toBeTruthy();
        const list = screen.getByRole("list", { name: "Replaces" });
        const google = within(list).getByRole("img", { name: "Google Calendar" });
        expect(google.getAttribute("src")).toBe(replacedLogoSrc(appReplaces("calendar")[0]!));
        expect(google.closest("li")?.getAttribute("title")).toBe("Google Calendar");
        expect(within(list).getAllByRole("listitem")).toHaveLength(appReplaces("calendar").length);
    });

    it("draws no row for an app with nothing to list", () => {
        render(
            <AppDetail appId="tools">
                <div />
            </AppDetail>,
            { wrapper: MessagesWrapper }
        );
        expect(screen.queryByRole("heading", { name: "Replaces" })).toBeNull();
    });
});

describe("a built-in app's row", () => {
    it("draws its logos, named in their tooltips", () => {
        render(<MarketplaceView scope="polaris" installed={[]} />, { wrapper: MessagesWrapper });
        const chat = document.querySelector('[data-built-in="chat"]') as HTMLElement;
        const list = within(chat).getByRole("list", { name: "Replaces" });
        expect(within(list).getByRole("img", { name: "Discord" })).toBeTruthy();
        expect(within(list).getByTitle("Microsoft Teams")).toBeTruthy();
    });
});
