// @vitest-environment jsdom
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * The Bot profile section: it shows what Telegram holds, and after a branding
 * run each field says on its own whether it changed or why it did not.
 */

const telegramBotProfileAction = vi.fn(async (_id: unknown) => ({
    profile: { username: "dymo_bot", name: "Dymo", description: "", shortDescription: "", hasPhoto: false }
}));
const applyTelegramBotProfileAction = vi.fn(async (_input: unknown) => ({
    results: [
        { field: "name", ok: false, error: "Telegram asks to wait 25 minutes before changing this again." },
        { field: "description", ok: true },
        { field: "shortDescription", ok: true },
        { field: "photo", ok: true }
    ],
    profile: { username: "dymo_bot", name: "Dymo", description: "Polaris sends", shortDescription: "Codes", hasPhoto: true }
}));

vi.mock("@/app/(app)/admin/integrations/messaging/actions", () => ({
    telegramBotProfileAction,
    applyTelegramBotProfileAction
}));

const { TelegramBotProfile } = await import("@/app/(app)/admin/integrations/messaging/telegram-bot-profile");

afterEach(cleanup);

describe("TelegramBotProfile", () => {
    it("shows the bot, brands it, and reports each field", async () => {
        render(<TelegramBotProfile channelId="c1" />, { wrapper: MessagesWrapper });
        expect(screen.getByText("Bot profile")).toBeTruthy();
        const link = await screen.findByRole("link", { name: /@dymo_bot/ });
        expect(link.getAttribute("href")).toBe("https://t.me/dymo_bot");
        expect((screen.getByLabelText("Name on Telegram") as HTMLInputElement).value).toBe("Dymo");
        expect(screen.getByRole("button", { name: "Save to Telegram" }).hasAttribute("disabled")).toBe(true);

        fireEvent.click(screen.getByRole("button", { name: /Use Polaris branding/ }));
        expect(await screen.findByText("Telegram asks to wait 25 minutes before changing this again.")).toBeTruthy();
        expect(screen.getAllByText("Changed")).toHaveLength(3);
        expect(applyTelegramBotProfileAction).toHaveBeenCalledWith({ channelId: "c1", mode: "polaris" });
        expect(screen.getByText("Set")).toBeTruthy();
    });

    it("sends only the field that changed", async () => {
        render(<TelegramBotProfile channelId="c1" />, { wrapper: MessagesWrapper });
        const name = (await screen.findByLabelText("Name on Telegram")) as HTMLInputElement;
        fireEvent.change(name, { target: { value: "  Acme  " } });
        fireEvent.click(screen.getByRole("button", { name: "Save to Telegram" }));
        await screen.findByText("Telegram asks to wait 25 minutes before changing this again.");
        expect(applyTelegramBotProfileAction).toHaveBeenLastCalledWith({ channelId: "c1", mode: "custom", name: "Acme" });
    });
});
