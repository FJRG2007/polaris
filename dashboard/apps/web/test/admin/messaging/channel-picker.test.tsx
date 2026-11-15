// @vitest-environment jsdom

/**
 * Picking the service a new messaging channel sends through: the same searchable
 * list the email senders and AI keys use, each row drawn with its platform's
 * mark, the official WhatsApp API first and WhatsApp Web labelled with its ban
 * risk and never the default.
 */

import { MessagesWrapper } from "../../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(app)/admin/integrations/messaging/actions", () => ({
    connectMessagingChannelAction: vi.fn(),
    deleteMessagingChannelAction: vi.fn(),
    messagingChannelStateAction: vi.fn(),
    reconnectMessagingChannelAction: vi.fn(),
    updateMessagingChannelAction: vi.fn(),
    setCodeSenderAction: vi.fn()
}));

import { MessagingChannelDialog } from "@/app/(app)/admin/integrations/messaging/channel-dialog";

afterEach(cleanup);

function renderDialog() {
    return render(<MessagingChannelDialog channel={null} onClose={() => {}} onSaved={() => {}} onRemoved={() => {}} />, {
        wrapper: MessagesWrapper
    });
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: /pick a provider/i }));
    return screen.getByPlaceholderText("Search providers");
}

function rowNames(): string[] {
    return screen.getAllByRole("menuitem").map((row) => row.textContent ?? "");
}

describe("the Add channel service list", () => {
    it("starts on the official WhatsApp Cloud API and asks for its template", () => {
        renderDialog();
        expect(screen.getByText("WhatsApp Cloud API")).toBeTruthy();
        expect(screen.getByText("Code template name")).toBeTruthy();
        expect(screen.getByText("Template language")).toBeTruthy();
    });

    it("lists every service with WhatsApp Web last and labelled with its ban risk", async () => {
        const user = userEvent.setup();
        renderDialog();
        await openPicker(user);
        const names = rowNames();
        expect(names[0]).toBe("WhatsApp Cloud API");
        expect(names.at(-1)).toBe("WhatsApp Web (unofficial, may be banned)");
        expect(names).toContain("Telegram");
        expect(names).toContain("WhatsApp via Twilio");
    });

    it("draws every row with a mark, never the generic block", async () => {
        const user = userEvent.setup();
        renderDialog();
        await openPicker(user);
        for (const row of screen.getAllByRole("menuitem")) {
            expect(row.querySelector("svg")).not.toBeNull();
            expect(row.querySelector(".lucide-blocks")).toBeNull();
        }
    });

    it("finds a service by the words people search with", async () => {
        const user = userEvent.setup();
        renderDialog();
        const search = await openPicker(user);
        await user.type(search, "twilio");
        expect(rowNames()).toEqual(["WhatsApp via Twilio"]);
        await user.clear(search);
        await user.type(search, "webhook");
        expect(rowNames()).toEqual(["Discord webhook", "Slack webhook"]);
    });
});
