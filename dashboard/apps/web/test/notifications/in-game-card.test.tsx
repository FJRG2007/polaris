/**
 * The Messages in Minecraft card, before and after a server knows which player
 * an account is.
 *
 * Until then there is nothing a choice would change, so the choices are shown
 * but cannot be made, and the card says what makes them possible and links to
 * where it is done.
 */

import { withMessages } from "../setup/i18n";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
    usePathname: () => "/account/notifications"
}));

vi.mock("@/app/(app)/account/notifications/actions", () => ({
    saveNotificationRuleAction: vi.fn(),
    saveSoundVolumeAction: vi.fn(),
    setMessagesInGameAction: vi.fn()
}));

const { NotificationSettingsView } =
    await import("@/app/(app)/account/notifications/notification-settings-view");
const { IN_GAME_NOT_READY } = await import("@/lib/chat/in-game-choice");

function card(ready: boolean): string {
    const markup = renderToStaticMarkup(
        withMessages(
            <NotificationSettingsView
                rules={[]}
                destinations={[]}
                senders={[]}
                deliveries={[]}
                messagesInGame="auto"
                inGameReady={ready}
            />
        )
    );
    const start = markup.indexOf("Messages in Minecraft");
    expect(start).toBeGreaterThan(-1);
    return markup.slice(start, start + 4000);
}

describe("the Messages in Minecraft card", () => {
    it("cannot be chosen until a server knows which player the account is, and says how", () => {
        const markup = card(false);
        const group = markup.slice(markup.indexOf("Which Chat messages to show in Minecraft"));
        expect(group.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(3);
        expect(markup).toContain(IN_GAME_NOT_READY.slice(0, 40));
        expect(markup).toContain('href="/account/connections?return=%2Faccount%2Fnotifications"');
    });

    it("sits under the apps' own heading, which is absent with nothing an app adds", () => {
        expect(card(true)).toBeTruthy();
        const markup = (messagesInGame: "all" | null) =>
            renderToStaticMarkup(
                withMessages(
                    <NotificationSettingsView
                        rules={[]}
                        destinations={[]}
                        senders={[]}
                        deliveries={[]}
                        messagesInGame={messagesInGame}
                        inGameReady
                    />
                )
            );
        const shown = markup("all");
        expect(shown.indexOf("From your apps")).toBeGreaterThan(-1);
        expect(shown.indexOf("From your apps")).toBeLessThan(
            shown.indexOf("Messages in Minecraft")
        );
        expect(markup(null)).not.toContain("From your apps");
        expect(markup(null)).not.toContain("Messages in Minecraft");
    });

    it("offers the three choices once it does", () => {
        const markup = card(true);
        expect(markup).not.toContain(IN_GAME_NOT_READY.slice(0, 40));
        expect(markup).not.toContain('href="/account/connections');
        expect(markup).toContain("Direct messages and groups of up to");
    });
});
