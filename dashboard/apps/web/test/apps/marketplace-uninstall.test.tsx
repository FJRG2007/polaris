// @vitest-environment jsdom

/**
 * Uninstalling an app from the marketplace grid, with the real confirmation
 * dialog.
 *
 * The button sits beside the card's own link rather than inside it, and the
 * dialog's wording differs by app: Game servers warns that a world is never
 * deleted by uninstalling, Places says which containers stop. A test that
 * replaces the dialog cannot see either, which is why this one does not.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstalledAppView } from "@/lib/apps/install-service";
import { MarketplaceView } from "@/app/(app)/apps/marketplace/marketplace-view";
import { uninstallInstalledAppAction } from "@/app/(app)/apps/installed/[id]/actions";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MessagesWrapper } from "../setup/i18n";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));
vi.mock("@/app/(app)/apps/marketplace/actions", () => ({
    installAppAction: vi.fn(),
    listInstallTargetsAction: vi.fn(async () => []),
    listStorageConnectionsAction: vi.fn(async () => [])
}));
vi.mock("@/app/(app)/apps/installed/[id]/actions", () => ({
    uninstallInstalledAppAction: vi.fn()
}));

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

function installed(over: Partial<InstalledAppView>): InstalledAppView {
    return {
        id: "install-1",
        catalogId: "game-servers",
        name: "Game servers",
        status: "stopped",
        applicationId: null,
        targetId: null,
        createdAt: new Date("2026-01-01").toISOString(),
        ownerId: "owner-1",
        ...over
    };
}

describe("uninstalling from the marketplace grid", () => {
    it("warns that a world is never deleted, and refuses when the app says so", async () => {
        vi.mocked(uninstallInstalledAppAction).mockResolvedValue({
            error: "Delete your game servers first (Ark Island). Uninstalling Game servers never deletes a world."
        });
        render(<MarketplaceView installed={[installed({})]} />, { wrapper: MessagesWrapper });

        fireEvent.click(screen.getByRole("button", { name: "Uninstall Game servers" }));
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText(/worlds are never deleted by uninstalling/)).toBeTruthy();

        fireEvent.click(within(dialog).getByRole("button", { name: "Uninstall and delete data" }));
        expect(
            await screen.findByText(/Delete your game servers first \(Ark Island\)/)
        ).toBeTruthy();
        // Said in the dialog, and the same button tries again.
        expect(within(dialog).getByRole("button", { name: "Try again" })).toBeTruthy();
        expect(refresh).not.toHaveBeenCalled();
    });

    it("names Places' containers, and removes the card once it goes through", async () => {
        vi.mocked(uninstallInstalledAppAction).mockResolvedValue({});
        render(
            <MarketplaceView
                installed={[installed({ id: "install-2", catalogId: "home", name: "Places" })]}
            />,
            { wrapper: MessagesWrapper }
        );

        fireEvent.click(screen.getByRole("button", { name: "Uninstall Places" }));
        const dialog = await screen.findByRole("dialog");
        // Keeping the data is the choice that says what stays.
        fireEvent.click(within(dialog).getByRole("checkbox"));
        expect(within(dialog).getByText(/camera and recognition containers stop/)).toBeTruthy();
        // Its data is rows, not volumes, so the storage screen never lists it.
        expect(within(dialog).queryByText(/listed under Storage/)).toBeNull();

        fireEvent.click(within(dialog).getByRole("button", { name: "Uninstall, keep data" }));
        await waitFor(() =>
            expect(uninstallInstalledAppAction).toHaveBeenCalledWith("install-2", {
                deleteData: false
            })
        );
        await waitFor(() => expect(refresh).toHaveBeenCalled());
    });

    it("says where kept data is listed for an app with containers", async () => {
        render(
            <MarketplaceView
                installed={[
                    installed({
                        id: "install-3",
                        catalogId: "messaging-bridge",
                        name: "Messaging bridge",
                        applicationId: "app-3"
                    })
                ]}
            />,
            { wrapper: MessagesWrapper }
        );

        fireEvent.click(screen.getByRole("button", { name: "Uninstall Messaging bridge" }));
        const dialog = await screen.findByRole("dialog");
        fireEvent.click(within(dialog).getByRole("checkbox"));
        expect(within(dialog).getByText(/listed under Storage/)).toBeTruthy();
    });

    it("leaves the app installed when Cancel is pressed", async () => {
        render(<MarketplaceView installed={[installed({})]} />, { wrapper: MessagesWrapper });

        fireEvent.click(screen.getByRole("button", { name: "Uninstall Game servers" }));
        const dialog = await screen.findByRole("dialog");
        fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        expect(uninstallInstalledAppAction).not.toHaveBeenCalled();
    });
});
