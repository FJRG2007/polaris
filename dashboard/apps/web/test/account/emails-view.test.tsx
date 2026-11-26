// @vitest-environment jsdom

/**
 * The account's email addresses: a table with each row's actions behind its
 * three dots, and "Add email" in the header opening a dialog that checks the
 * address as it is typed - never an inline field under the list.
 */

import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const actions = vi.hoisted(() => ({
    add: vi.fn(async (_email: string): Promise<{ error?: string }> => ({})),
    recovery: vi.fn(async (_id: unknown, _on: boolean): Promise<{ error?: string }> => ({}))
}));
vi.mock("@/app/(app)/account/actions", () => ({
    addEmailAction: actions.add,
    promoteEmailAction: vi.fn(async () => ({})),
    promoteEmailOpaqueAction: vi.fn(async () => ({})),
    removeEmailAction: vi.fn(async () => ({})),
    setEmailRecoveryAction: actions.recovery,
    verifyEmailAction: vi.fn(async () => ({}))
}));

const { EmailsView } = await import("@/app/(app)/account/emails-view");

afterEach(() => {
    cleanup();
    actions.add.mockClear();
    actions.recovery.mockClear();
});

const PRIMARY = { id: null, email: "owner@example.test", primary: true, verified: true, recovery: false };
const OTHER = { id: "e2", email: "other@example.test", primary: false, verified: false, recovery: false };

function renderView() {
    return render(
        <MessagesWrapper>
            <EmailsView emails={[PRIMARY, OTHER] as never} mailReady />
        </MessagesWrapper>
    );
}

describe("EmailsView", () => {
    it("draws the addresses as a table with no inline add field", () => {
        renderView();
        expect(screen.getByRole("table")).toBeTruthy();
        expect(screen.queryByRole("textbox")).toBeNull();
        expect(screen.getByRole("button", { name: "Add email" })).toBeTruthy();
        // The primary, verified, has nothing to do from a menu.
        expect(screen.queryByRole("button", { name: "Actions for owner@example.test" })).toBeNull();
    });

    it("keeps an alternate's actions in its row menu", async () => {
        renderView();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Actions for other@example.test" }));
        for (const name of ["Verify", "Make primary", "Use for recovery", "Remove"]) {
            expect(await screen.findByRole("menuitem", { name })).toBeTruthy();
        }
        await user.click(screen.getByRole("menuitem", { name: "Use for recovery" }));
        expect(actions.recovery).toHaveBeenCalledWith("e2", true);
    });

    it("adds from the dialog, refusing an address already listed", async () => {
        renderView();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Add email" }));
        const dialog = within(await screen.findByRole("dialog"));
        const field = dialog.getByLabelText(/^Address/);
        const add = dialog.getByRole("button", { name: "Add" });
        expect(add.getAttribute("aria-disabled")).toBe("true");
        await user.type(field, "Other@Example.test");
        expect(dialog.getByText("That address is already on your account.")).toBeTruthy();
        await user.click(add);
        expect(actions.add).not.toHaveBeenCalled();
        await user.clear(field);
        await user.type(field, " new@example.test ");
        await user.click(add);
        await waitFor(() => expect(actions.add).toHaveBeenCalledWith("new@example.test"));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });
});
