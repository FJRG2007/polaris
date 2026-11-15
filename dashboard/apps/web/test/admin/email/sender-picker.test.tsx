// @vitest-environment jsdom

/**
 * Picking how a new email sender sends.
 *
 * The same searchable list the AI provider keys use: each provider drawn as its
 * own logo, found by the word somebody arrives with ("aws", "sendinblue"), and
 * always with two ways to send that need no account anywhere - an SMTP server
 * the operator already has, and Polaris's own mail server, which makes its own
 * sender and so shows no form, only the next step towards sending.
 */

import { MessagesWrapper } from "../../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

const { polarisMailStateAction, installMailServerAppAction, resumeSetupAction } = vi.hoisted(() => ({
    polarisMailStateAction: vi.fn(),
    installMailServerAppAction: vi.fn(),
    resumeSetupAction: vi.fn()
}));

vi.mock("@/app/(app)/admin/integrations/email/sender-actions", () => ({
    createEmailChannelAction: vi.fn(),
    deleteEmailChannelAction: vi.fn(),
    sendTestEmailAction: vi.fn(),
    updateEmailChannelAction: vi.fn()
}));
vi.mock("@/app/(app)/admin/integrations/email/mail-server-sender", () => ({ polarisMailStateAction }));
vi.mock("@/app/(app)/mail-server/actions", () => ({ installMailServerAppAction, resumeSetupAction }));

import type { EmailChannelView } from "@/lib/mail-service";
import { EmailChannelDialog } from "@/app/(app)/admin/integrations/email/email-channel-dialog";

afterEach(cleanup);
beforeEach(() => {
    vi.clearAllMocks();
});

function renderDialog(channel: EmailChannelView | null = null) {
    return render(
        <EmailChannelDialog channel={channel} onClose={() => {}} onSaved={() => {}} onRemoved={() => {}} />,
        { wrapper: MessagesWrapper }
    );
}

/** Open the provider list and return the field that narrows it. */
async function openPicker(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: /pick a provider/i }));
    return screen.getByPlaceholderText("Search providers");
}

function rowNames(): string[] {
    return screen.getAllByRole("menuitem").map((row) => row.textContent ?? "");
}

describe("the Add sender provider list", () => {
    it("lists Polaris's mail server first, an SMTP server, and every provider", async () => {
        const user = userEvent.setup();
        renderDialog();
        await openPicker(user);
        expect(rowNames()).toEqual([
            "Polaris mail server",
            "SMTP server",
            "Resend",
            "Brevo",
            "Mailjet",
            "Amazon SES"
        ]);
    });

    it("draws every row with its own logo, never the generic block", async () => {
        const user = userEvent.setup();
        renderDialog();
        await openPicker(user);
        for (const row of screen.getAllByRole("menuitem")) {
            expect(row.querySelector("svg")).not.toBeNull();
            expect(row.querySelector(".lucide-blocks")).toBeNull();
        }
    });

    it("keeps the vendors' own colours on the marks that have one", async () => {
        const user = userEvent.setup();
        renderDialog();
        await openPicker(user);
        const fill = (name: string) =>
            screen.getByRole("menuitem", { name }).querySelector("path")?.getAttribute("fill");
        expect(fill("Brevo")).toBe("#0B996E");
        expect(fill("Mailjet")).toBe("#9585f4");
        expect(fill("Amazon SES")).toBe("#DD344C");
        // Resend's brand page has it black on light and white on dark.
        expect(fill("Resend")).toBe("currentColor");
    });

    it("finds a provider by the word people use for it", async () => {
        const user = userEvent.setup();
        renderDialog();
        const field = await openPicker(user);
        await user.type(field, "aws");
        expect(rowNames()).toEqual(["Amazon SES"]);
        await user.clear(field);
        await user.type(field, "sendinblue");
        expect(rowNames()).toEqual(["Brevo"]);
    });

    it("does not offer the mail server when an existing sender is edited", async () => {
        const user = userEvent.setup();
        renderDialog({
            id: "ch-1",
            name: "Brevo",
            provider: "brevo",
            status: "connected",
            error: null,
            from: "polaris@example.test",
            settings: { from: "polaris@example.test" }
        } as unknown as EmailChannelView);
        await openPicker(user);
        expect(rowNames()).not.toContain("Polaris mail server");
        expect(rowNames()).toContain("SMTP server");
    });

    it("asks for the SMTP server's host, port and sign-in when that is chosen", async () => {
        const user = userEvent.setup();
        renderDialog();
        await openPicker(user);
        await user.click(screen.getByRole("menuitem", { name: "SMTP server" }));
        expect(screen.getByText("Host")).toBeTruthy();
        expect(screen.getByText("Port")).toBeTruthy();
        expect(screen.getByText("Username")).toBeTruthy();
    });
});

describe("the Polaris mail server choice", () => {
    async function choose(user: ReturnType<typeof userEvent.setup>) {
        renderDialog();
        await openPicker(user);
        await user.click(screen.getByRole("menuitem", { name: "Polaris mail server" }));
    }

    it("shows no form and no Add button, only the next step", async () => {
        polarisMailStateAction.mockResolvedValue({ kind: "no-server" });
        const user = userEvent.setup();
        await choose(user);
        const link = await screen.findByRole("link", { name: "Set up a mail server" });
        expect(link.getAttribute("href")).toBe("/mail-server");
        expect(screen.queryByText("Host")).toBeNull();
        expect(screen.queryByRole("button", { name: "Add sender" })).toBeNull();
    });

    it("turns the app on from the dialog for an administrator", async () => {
        polarisMailStateAction
            .mockResolvedValueOnce({ kind: "not-installed", canInstall: true })
            .mockResolvedValue({ kind: "no-server" });
        installMailServerAppAction.mockResolvedValue({});
        const user = userEvent.setup();
        await choose(user);
        await user.click(await screen.findByRole("button", { name: "Turn on Mail server" }));
        expect(installMailServerAppAction).toHaveBeenCalledTimes(1);
        expect(await screen.findByRole("link", { name: "Set up a mail server" })).toBeTruthy();
    });

    it("tells anybody else who can turn it on, with no button they cannot use", async () => {
        polarisMailStateAction.mockResolvedValue({ kind: "not-installed", canInstall: false });
        const user = userEvent.setup();
        await choose(user);
        expect(await screen.findByText(/Ask an administrator to turn it on/)).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Turn on Mail server" })).toBeNull();
    });

    it("creates the sender on a ready server without asking for anything", async () => {
        polarisMailStateAction.mockResolvedValue({
            kind: "ready",
            serverId: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
            hostname: "mail.example.test"
        });
        resumeSetupAction.mockResolvedValue({});
        const user = userEvent.setup();
        await choose(user);
        await user.click(await screen.findByRole("button", { name: "Send through mail.example.test" }));
        expect(resumeSetupAction).toHaveBeenCalledWith({
            serverId: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
            from: "sender"
        });
        expect(await screen.findByText(/Creating the sender on mail.example.test/)).toBeTruthy();
    });

    it("points at the server that is still being set up", async () => {
        polarisMailStateAction.mockResolvedValue({
            kind: "setting-up",
            serverId: "srv-1",
            hostname: "mail.example.test"
        });
        const user = userEvent.setup();
        await choose(user);
        const dialog = await screen.findByRole("dialog");
        const link = await within(dialog).findByRole("link", { name: "Open mail server" });
        expect(link.getAttribute("href")).toBe("/mail-server/srv-1");
    });

    it("offers to try again when the check fails", async () => {
        polarisMailStateAction.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ kind: "no-server" });
        const user = userEvent.setup();
        await choose(user);
        await user.click(await screen.findByRole("button", { name: "Try again" }));
        expect(await screen.findByRole("link", { name: "Set up a mail server" })).toBeTruthy();
    });
});
