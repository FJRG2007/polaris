// @vitest-environment jsdom

/**
 * A right click on an app: making it a favorite and opening it on entering
 * Polaris, from inside the app menu, with the menu still there afterwards.
 */

import { withMessages } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { HardDrive, MessageCircle } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const save = vi.fn<(input: unknown) => Promise<{ error?: string }>>();

vi.mock("next/navigation", () => ({ usePathname: () => "/home" }));
vi.mock("@/components/notifications/notifications-provider", () => ({
    useHoldConversationNotices: () => () => ({ settle: () => undefined, abandon: () => undefined })
}));
vi.mock("@/app/(app)/app-launcher-actions", () => ({
    saveFavoriteAppsAction: (input: unknown) => save(input)
}));
vi.mock("@/app/(app)/launcher-waiting-actions", () => ({
    markLauncherReadAction: async () => ({})
}));

const { FavoriteAppsProvider } = await import("@/components/favorite-apps");
const { AppLauncher } = await import("@/components/app-nav");

const apps = [
    { id: "drive", label: "Drive", description: "Files", icon: HardDrive, href: "/drive" },
    { id: "chat", label: "Chat", description: "Talk", icon: MessageCircle, href: "/chat" },
    { id: "overview", label: "Overview", description: "Home", icon: HardDrive, href: "/home" }
];

beforeEach(() => {
    save.mockReset();
    save.mockResolvedValue({});
});
afterEach(cleanup);

async function openOn(name: string, home: string | null = null) {
    const user = userEvent.setup();
    render(
        withMessages(
            <FavoriteAppsProvider initial={[]} initialHome={home}>
                <AppLauncher apps={apps} currentAppId="drive" />
            </FavoriteAppsProvider>
        )
    );
    await user.click(screen.getByRole("button", { name: /drive/i }));
    await screen.findByRole("menu");
    const tile = document.querySelector(`[data-launcher-tile="${name}"], a[href="/${name}"]`);
    fireEvent.contextMenu(tile!);
    return user;
}

describe("right-clicking an app in the menu", () => {
    it("makes it a favorite, and leaves the menu open", async () => {
        const user = await openOn("chat");
        await user.click(await screen.findByRole("menuitem", { name: "Add to favorites" }));
        expect(save).toHaveBeenCalledWith({ favorites: ["chat"], order: [], home: null });
        await waitFor(() =>
            expect(screen.queryByRole("menuitem", { name: "Add to favorites" })).toBeNull()
        );
        expect(document.querySelector('a[href="/chat"]')).toBeTruthy();
    });

    it("chooses it as the app to open on entry", async () => {
        const user = await openOn("chat");
        await user.click(await screen.findByRole("menuitem", { name: "Open on entry" }));
        expect(save).toHaveBeenCalledWith({ favorites: [], order: [], home: "chat" });
    });

    it("takes the choice back on the same app", async () => {
        const user = await openOn("chat", "chat");
        await user.click(await screen.findByRole("menuitem", { name: "Stop opening on entry" }));
        expect(save).toHaveBeenCalledWith({ favorites: [], order: [], home: null });
    });
});
