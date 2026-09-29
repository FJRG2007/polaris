// @vitest-environment jsdom

/**
 * The switch that decides whether opening a screen clears its badge.
 *
 * Shown only to an account with such a badge - an administrator - and saved at
 * once, put back with the reason when the save is refused.
 */

import { MessagesWrapper, withMessages } from "../setup/i18n";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const save = vi.fn(async (_enabled: boolean): Promise<{ error?: string }> => ({}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() })
}));

vi.mock("@/app/(app)/account/notifications/actions", () => ({
    saveNotificationRuleAction: vi.fn(),
    saveSoundVolumeAction: vi.fn(),
    setMessagesInGameAction: vi.fn(),
    setBadgesClearOnVisitAction: (enabled: boolean) => save(enabled)
}));

const { NotificationSettingsView } =
    await import("@/app/(app)/account/notifications/notification-settings-view");

function view(badgesClearOnVisit: boolean | null) {
    return (
        <NotificationSettingsView
            rules={[]}
            destinations={[]}
            senders={[]}
            deliveries={[]}
            badgesClearOnVisit={badgesClearOnVisit}
        />
    );
}

afterEach(() => {
    cleanup();
    save.mockClear();
});

describe("the badges switch", () => {
    it("is not offered to an account with no such badge", () => {
        render(view(null), { wrapper: MessagesWrapper });
        expect(screen.queryByText("Clear badges when I open the screen")).toBeNull();
    });

    it("saves the choice and says what it now means", async () => {
        render(view(true), { wrapper: MessagesWrapper });
        const toggle = screen.getByRole("switch", { name: "Clear a badge when I open its screen" });
        fireEvent.click(toggle);
        await waitFor(() => expect(save).toHaveBeenCalledWith(false));
        expect(screen.getByText(/Badges stay until the work is done/)).toBeTruthy();
    });

    it("goes back with the reason when the save is refused", async () => {
        save.mockResolvedValueOnce({ error: "That could not be saved." });
        render(view(true), { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("switch", { name: "Clear a badge when I open its screen" }));
        await waitFor(() => expect(screen.getByText("That could not be saved.")).toBeTruthy());
        expect(screen.getByText(/stops counting once you have opened its screen/)).toBeTruthy();
    });

    it("reads in Spanish", () => {
        render(withMessages(view(true), "es-ES"));
        expect(screen.getByText("Quitar avisos al abrir la pantalla")).toBeTruthy();
    });
});
