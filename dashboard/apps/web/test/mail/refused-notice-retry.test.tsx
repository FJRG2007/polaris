// @vitest-environment jsdom

/** "Try now" always comes back: a failed try says so and can be pressed again. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RefusedMailboxes } from "@/app/(app)/mail/refused-notice";
import { MessagesWrapper } from "../setup/i18n";

const sync = vi.hoisted(() => vi.fn());

vi.mock("@/app/(app)/mail/actions", () => ({ syncAccountAction: sync }));
vi.mock("@/lib/new-build", () => ({ checkForNewBuild: async () => undefined }));

const refused = {
    id: "a",
    address: "ana@example.test",
    auth: "password",
    state: "auth",
    imapHost: "imap.example.test",
    lastOkAt: "2026-11-01T08:00:00.000Z",
    refusedSince: new Date().toISOString(),
    lastRefusedAt: new Date().toISOString()
} as const;

afterEach(() => {
    cleanup();
    sync.mockReset();
    vi.restoreAllMocks();
});

function press(): HTMLElement {
    render(<RefusedMailboxes accounts={[refused]} />, { wrapper: MessagesWrapper });
    const button = screen.getByRole("button", { name: "Try now" });
    fireEvent.click(button);
    return button;
}

describe("trying a refused mailbox now", () => {
    it("gives the button back and says so when the action rejects", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        sync.mockRejectedValue(new Error("Failed to find Server Action"));
        const button = press();
        expect(await screen.findByText("The request could not be completed. Try again.")).toBeTruthy();
        expect((button as HTMLButtonElement).disabled).toBe(false);
    });

    it("shows the reason the action answered with", async () => {
        sync.mockResolvedValue({ error: "Polaris could not check this mailbox." });
        press();
        expect(await screen.findByText("Polaris could not check this mailbox.")).toBeTruthy();
    });
});
