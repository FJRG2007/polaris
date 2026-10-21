// @vitest-environment jsdom

/**
 * An app's Marketplace page: the manifest paints with the shell, Install and
 * Uninstall appear only for a reader the server would let use them, and
 * deleting the data is a separate, ticked choice in the app's own dialog.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { uninstallInstalledAppAction } from "@/app/(app)/apps/installed/[id]/actions";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
    AppDetail,
    AppInstallPanel,
    type DetailInstall
} from "@/app/(app)/apps/marketplace/[appId]/app-detail";
import { MessagesWrapper } from "../setup/i18n";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
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
    uninstallInstalledAppAction: vi.fn(async () => ({}))
}));

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

function install(over: Partial<DetailInstall> = {}): DetailInstall {
    return {
        id: "install-1",
        catalogId: "minecraft",
        name: "Survival",
        status: "running",
        applicationId: "app-1",
        targetId: "target-1",
        createdAt: new Date("2026-01-01").toISOString(),
        ownerId: "owner-1",
        canUninstall: true,
        ...over
    };
}

describe("the app page", () => {
    it("paints the manifest and its children without waiting on anything", () => {
        render(
            <AppDetail appId="calendar">
                <p>install region</p>
            </AppDetail>,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByRole("heading", { level: 1 }).textContent).toBeTruthy();
        expect(screen.getByText("install region")).toBeTruthy();
        expect(screen.getByRole("link", { name: /All apps/ })).toBeTruthy();
        // Calendar has the README's captures; both themes are in the page.
        expect(
            screen
                .getAllByRole("img")
                .some((img) => img.getAttribute("src")?.includes("calendar-dark-en-desktop"))
        ).toBe(true);
    });

    it("shows no screenshots for an app that has none", () => {
        render(
            <AppDetail appId="minecraft">
                <span />
            </AppDetail>,
            { wrapper: MessagesWrapper }
        );
        expect(screen.queryByText("Screenshots")).toBeNull();
        expect(
            screen
                .queryAllByRole("img")
                .filter((img) => img.getAttribute("src")?.startsWith("/marketplace/"))
        ).toHaveLength(0);
    });

    it("is read-only for a reader who may not install", () => {
        render(<AppInstallPanel appId="minecraft" canInstall={false} installs={[]} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.queryByRole("button", { name: /^Install/ })).toBeNull();
        expect(screen.getByText(/needs permission to manage apps/)).toBeTruthy();
        expect(screen.queryByRole("button", { name: /Needs permission/ })).toBeNull();
        expect(screen.getAllByText(/Ask an admin/)).toHaveLength(1);
    });

    it("offers Install and Configure to a reader who may", () => {
        render(<AppInstallPanel appId="minecraft" canInstall installs={[]} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByRole("button", { name: "Install" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Configure" })).toBeTruthy();
    });

    it("hides Uninstall from somebody the server would refuse", () => {
        render(
            <AppInstallPanel
                appId="minecraft"
                canInstall
                installs={[install({ canUninstall: false })]}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.queryByRole("button", { name: /Uninstall/ })).toBeNull();
        expect(screen.getByText(/Only the person who installed an app/)).toBeTruthy();
    });

    it("deletes the data by default, and keeps it only when the reader unticks it", async () => {
        render(<AppInstallPanel appId="minecraft" canInstall installs={[install()]} />, {
            wrapper: MessagesWrapper
        });
        fireEvent.click(screen.getByRole("button", { name: /Uninstall/ }));
        let dialog = await screen.findByRole("dialog");
        expect((within(dialog).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
        expect(within(dialog).getByText(/cannot be undone/)).toBeTruthy();
        fireEvent.click(within(dialog).getByRole("button", { name: "Uninstall and delete data" }));
        await waitFor(() =>
            expect(uninstallInstalledAppAction).toHaveBeenCalledWith("install-1", {
                deleteData: true
            })
        );
        await waitFor(() => expect(refresh).toHaveBeenCalled());

        fireEvent.click(screen.getByRole("button", { name: /Uninstall/ }));
        dialog = await screen.findByRole("dialog");
        fireEvent.click(within(dialog).getByRole("checkbox"));
        expect(within(dialog).getByText(/listed under Storage/)).toBeTruthy();
        fireEvent.click(within(dialog).getByRole("button", { name: "Uninstall, keep data" }));
        await waitFor(() =>
            expect(uninstallInstalledAppAction).toHaveBeenLastCalledWith("install-1", {
                deleteData: false
            })
        );
    });

    it("shows the server's refusal inside the dialog", async () => {
        vi.mocked(uninstallInstalledAppAction).mockResolvedValueOnce({ error: "Refused here" });
        render(<AppInstallPanel appId="minecraft" canInstall installs={[install()]} />, {
            wrapper: MessagesWrapper
        });
        fireEvent.click(screen.getByRole("button", { name: /Uninstall/ }));
        const dialog = await screen.findByRole("dialog");
        fireEvent.click(within(dialog).getByRole("button", { name: "Uninstall and delete data" }));
        expect(await within(dialog).findByText("Refused here")).toBeTruthy();
        expect(refresh).not.toHaveBeenCalled();
        // Running it again picks up where it stopped.
        fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
        await waitFor(() => expect(refresh).toHaveBeenCalled());
        expect(uninstallInstalledAppAction).toHaveBeenCalledTimes(2);
    });
});
