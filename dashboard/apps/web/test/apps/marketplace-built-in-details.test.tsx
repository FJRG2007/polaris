// @vitest-environment jsdom

/**
 * An app every Polaris comes with, on the Polaris apps screen: its card's menu
 * has Details and an Uninstall that is switched off with the reason, and its
 * own page opens from there, with Settings only where the app has
 * administrator settings.
 */

import type { ReactElement } from "react";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { builtInSettingsHref } from "@/lib/apps/app-settings";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MarketplaceView } from "@/app/(app)/apps/marketplace/marketplace-view";
import { builtInApps, builtInHref, findStoreApp } from "@/lib/apps/marketplace-store";
import { resolveActiveApp } from "@/lib/apps";
import { NATIVE_APPS } from "@/lib/apps/native-apps";
import { appUpdatesAction } from "@/lib/app-bundles/actions";

const push = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push, refresh: vi.fn() }),
    notFound: () => {
        throw new Error("not found");
    },
    redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
    }
}));
vi.mock("@/lib/session", () => ({
    requireAdmin: vi.fn(async () => ({ id: "admin-1", isAdmin: true }))
}));
vi.mock("@/lib/app-bundles/actions", () => ({
    appUpdatesAction: vi.fn(async () => []),
    changeAppBuildAction: vi.fn()
}));
vi.mock("@/app/(app)/apps/deploy/actions", () => ({
    listDeployServersAction: vi.fn(async () => []),
    createApplicationAction: vi.fn()
}));
vi.mock("@/app/(app)/apps/marketplace/actions", () => ({
    installAppAction: vi.fn(),
    listStorageConnectionsAction: vi.fn(async () => [])
}));
vi.mock("@/app/(app)/apps/marketplace/store-installs", () => ({
    AppInstallState: () => null,
    AppSettingsLink: () => null
}));
vi.mock("@/app/(app)/apps/installed/[id]/actions", () => ({
    uninstallInstalledAppAction: vi.fn()
}));

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

async function openMenu(name: string): Promise<void> {
    fireEvent.pointerDown(screen.getByLabelText(`More for ${name}`), {
        button: 0,
        ctrlKey: false,
        pointerType: "mouse"
    });
    await screen.findByRole("menu");
}

describe("a built-in app's card menu", () => {
    it("offers Details, and Uninstall switched off with the reason", async () => {
        render(<MarketplaceView scope="polaris" installed={[]} canUpdateApps={false} />, {
            wrapper: MessagesWrapper
        });
        await openMenu("Chat");
        fireEvent.click(screen.getByRole("menuitem", { name: "Details" }));
        expect(push).toHaveBeenCalledWith("/admin/apps/chat");

        await openMenu("Chat");
        const uninstall = screen.getByRole("menuitem", { name: /Uninstall/ });
        expect(uninstall.getAttribute("aria-disabled")).toBe("true");
        expect(uninstall.textContent).toContain("Built in - every Polaris needs it");
        expect(screen.getByRole("menuitem", { name: "Settings" })).toBeTruthy();
    });

    it("names the app's page from its title", () => {
        render(<MarketplaceView scope="polaris" installed={[]} canUpdateApps={false} />, {
            wrapper: MessagesWrapper
        });
        const title = screen.getAllByRole("link", { name: "Chat" })[0];
        expect(title.getAttribute("href")).toBe("/admin/apps/chat");
    });
});

describe("a built-in app's settings", () => {
    it.each(builtInApps().map((entry) => [entry.id]))(
        "%s opens the administrator settings, or none",
        (id) => {
            const href = builtInSettingsHref(id);
            if (href !== null) expect(href.startsWith("/admin/")).toBe(true);
        }
    );

    it("never shares an id with a catalog app, so its page is the one drawn", () => {
        for (const entry of builtInApps()) expect(findStoreApp(entry.id)).toBeUndefined();
    });
});

describe("a built-in app's page", () => {
    async function page(appId: string): Promise<ReactElement> {
        const { default: PolarisAppPage } = await import("@/app/(app)/admin/apps/[appId]/page");
        return (await PolarisAppPage({ params: Promise.resolve({ appId }) })) as ReactElement;
    }

    it("draws Open, Settings and a switched-off Uninstall for Chat", async () => {
        render(await page("chat"), { wrapper: MessagesWrapper });
        expect(screen.getByRole("heading", { level: 1, name: "Chat" })).toBeTruthy();
        expect(screen.getByRole("link", { name: "Open" }).getAttribute("href")).toBe("/chat");
        expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(
            "/admin/apps/chat/settings"
        );
        const uninstall = screen.getByRole("button", { name: /Uninstall/ });
        expect((uninstall as HTMLButtonElement).disabled).toBe(true);
        expect(uninstall.getAttribute("aria-describedby")).toBeTruthy();
        expect(screen.getByText("Built in - every Polaris needs it")).toBeTruthy();
    });

    it("leaves Settings out for an app with no administrator settings", async () => {
        const plain = builtInApps().find((entry) => !builtInSettingsHref(entry.id));
        expect(plain).toBeTruthy();
        render(await page(plain!.id), { wrapper: MessagesWrapper });
        expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
        expect(builtInHref(plain!.id)).toBe(`/admin/apps/${plain!.id}`);
    });

    it("says the update check failed instead of claiming no build", async () => {
        vi.mocked(appUpdatesAction).mockRejectedValueOnce(new Error("refused"));
        const host = resolveActiveApp(Object.values(NATIVE_APPS)[0]!).id;
        render(await page(host), { wrapper: MessagesWrapper });
        expect(await screen.findByText("Could not check for updates")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Check for app updates" })).toBeTruthy();
        expect(screen.queryByText("No build of its own")).toBeNull();
    });

    it("is not found for an id nothing knows", async () => {
        await expect(page("no-such-app")).rejects.toThrow("not found");
    });
});
