// @vitest-environment jsdom

/**
 * What somebody sees when a mailbox stops accepting its password, and where the
 * button takes them.
 *
 * The notice is only worth drawing if it says which mailbox, says it the way
 * the person would, and the button beside it is the fix. The fix is the edit
 * form, open on that mailbox with the password box empty - empty keeps the one
 * stored - and the address shown rather than asked for, because a different
 * address is a different mailbox.
 */

import { ToastProvider } from "@polaris/ui";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { ConnectMailboxDialog } from "@/app/(app)/mail/connect-dialog";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AccountsView } from "@/app/(app)/mail/settings/accounts/accounts-view";
import { RefusedMailboxes, refusedNotices } from "@/app/(app)/mail/refused-notice";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const updates: unknown[] = [];
/** When the servers answer. Resolved at once unless a test holds it open to
 *  look at the screen in between. */
const held: { answer: Promise<void> } = { answer: Promise.resolve() };

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined })
}));
vi.mock("@/app/(app)/mail/actions", () => ({
    addAccountAction: async () => ({}),
    discoverAction: async () => ({}),
    editAccountAction: async () => ({}),
    removeAccountAction: async () => ({}),
    syncAccountAction: async () => ({}),
    updateAccountAction: async (_id: string, input: unknown) => {
        updates.push(input);
        await held.answer;
        return { error: "The mail server refused this account's credentials.", field: "password" };
    }
}));

beforeAll(() => {
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    Element.prototype.scrollIntoView ??= () => {};
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
});

afterEach(() => {
    cleanup();
    updates.length = 0;
});

function account(overrides: Partial<MailAccountView> = {}): MailAccountView {
    return {
        id: "0190c1d2-0000-7000-8000-000000000001",
        address: "ana@example.com",
        displayName: "Ana",
        label: "Work",
        color: null,
        service: "",
        serviceName: "",
        auth: "password",
        connectionId: null,
        username: "",
        imapHost: "imap.example.com",
        imapPort: 993,
        imapSecurity: "tls",
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpSecurity: "tls",
        state: "auth",
        stateDetail: "The mail server refused this account's credentials.",
        lastSyncAt: null,
        notify: true,
        unified: true,
        appendToSent: true,
        signature: "",
        signatureAboveQuote: true,
        remoteContent: "always",
        nameTrackers: true,
        answerReceipts: false,
        cleanLinks: true,
        signatureAuto: "new",
        securityKeepMinutes: 0,
        spamFilter: true,
        vacationEnabled: false,
        pollSeconds: 300,
        position: 0,
        ...overrides
    };
}

describe("the notice", () => {
    it("names the mailbox and offers the fix", () => {
        render(<RefusedMailboxes accounts={[account()]} />);
        expect(screen.getByText("ana@example.com stopped accepting its password")).toBeTruthy();
        const button = screen.getByRole("link", { name: "Update password" });
        expect(button.getAttribute("href")).toBe(
            "/mail/settings/accounts?edit=0190c1d2-0000-7000-8000-000000000001"
        );
    });

    it("says reconnect for an authorized mailbox", () => {
        render(<RefusedMailboxes accounts={[account({ auth: "oauth" })]} />);
        expect(screen.getByText("ana@example.com stopped accepting its authorization")).toBeTruthy();
        expect(screen.getByRole("link", { name: "Reconnect" })).toBeTruthy();
    });

    it("draws nothing while every mailbox works", () => {
        const { container } = render(
            <RefusedMailboxes accounts={[account({ state: "ok" }), account({ state: "unreachable" })]} />
        );
        expect(container.innerHTML).toBe("");
        expect(refusedNotices([account({ state: "never" })])).toEqual([]);
    });
});

describe("the edit form it opens", () => {
    function open(target: MailAccountView) {
        render(
            <ToastProvider>
                <ConnectMailboxDialog
                    editing={target}
                    focusPassword
                    title="Edit mailbox"
                    links={[]}
                    googleReady
                    microsoftReady
                    publicAddress
                    canSetDomain={false}
                    onClose={() => undefined}
                />
            </ToastProvider>
        );
    }

    it("shows the address, fills in what is stored, and leaves the password empty", () => {
        open(account());
        const address = screen.getByDisplayValue("ana@example.com") as HTMLInputElement;
        expect(address.readOnly).toBe(true);
        expect(screen.getByDisplayValue("Work")).toBeTruthy();
        const password = screen.getByPlaceholderText("Leave blank to keep the current one");
        expect((password as HTMLInputElement).value).toBe("");
        expect(document.activeElement).toBe(password);
        expect(screen.getByText(/stopped accepting the saved password/)).toBeTruthy();
    });

    it("sends what was typed, and shows a refusal on the form", async () => {
        open(account());
        fireEvent.change(screen.getByPlaceholderText("Leave blank to keep the current one"), {
            target: { value: "new-secret" }
        });
        fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
        expect(
            await screen.findByText("The mail server refused this account's credentials.")
        ).toBeTruthy();
        expect(updates[0]).toMatchObject({ auth: "password", password: "new-secret", label: "Work" });
        expect(updates[0]).not.toHaveProperty("address");
    });

    it("keeps Save off while nothing differs from what is stored", () => {
        open(account({ state: "ok" }));
        const save = screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
        expect(save.disabled).toBe(true);
        fireEvent.change(screen.getByDisplayValue("Work"), { target: { value: "Home" } });
        expect(save.disabled).toBe(false);
        // Typed and put back is nothing to save.
        fireEvent.change(screen.getByDisplayValue("Home"), { target: { value: "Work" } });
        expect(save.disabled).toBe(true);
    });

    it("offers an authorized mailbox the way to authorize it again, not a password", () => {
        open(account({ auth: "oauth", service: "gmail", connectionId: null }));
        expect(screen.getByRole("link", { name: "Reconnect with Google" })).toBeTruthy();
        expect(screen.queryByPlaceholderText("Leave blank to keep the current one")).toBeNull();
    });
});

describe("the mailboxes screen the notice lands on", () => {
    function screenFor(target: MailAccountView, editNow = "") {
        render(
            <ToastProvider>
                <AccountsView
                    accounts={[target]}
                    links={[]}
                    googleReady
                    microsoftReady
                    publicAddress
                    canSetDomain={false}
                    outcome=""
                    outcomeProvider=""
                    editNow={editNow}
                />
            </ToastProvider>
        );
    }

    it("opens the named mailbox's form, on the password box", () => {
        const target = account();
        screenFor(target, target.id);
        expect(screen.getByRole("dialog")).toBeTruthy();
        expect(document.activeElement).toBe(
            screen.getByPlaceholderText("Leave blank to keep the current one")
        );
    });

    it("offers the fix on the row, and edits any mailbox from its pencil", () => {
        screenFor(account());
        expect(screen.getByRole("button", { name: "Update password" })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Edit this mailbox" }));
        expect(screen.getByRole("dialog")).toBeTruthy();
    });

    it("puts the row back when the servers refuse the change", async () => {
        screenFor(account());
        fireEvent.click(screen.getByRole("button", { name: "Edit this mailbox" }));
        const labelBox = screen.getAllByDisplayValue("Work").find((node) => node.tagName === "INPUT");
        fireEvent.change(labelBox as HTMLInputElement, { target: { value: "Home" } });
        fireEvent.change(screen.getByPlaceholderText("Leave blank to keep the current one"), {
            target: { value: "new-secret" }
        });
        let answer = () => undefined as void;
        held.answer = new Promise<void>((resolve) => {
            answer = resolve;
        });
        fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
        // Behind the open dialog, which hides the rest of the page from roles.
        const row = screen.getByRole("listitem", { hidden: true });
        // While the servers are asked: the new name, and that it is checking.
        await waitFor(() => expect(row.textContent).toContain("Home"));
        expect(row.textContent).toContain("Checking the new details");

        answer();
        held.answer = Promise.resolve();
        await screen.findByText("The mail server refused this account's credentials.");
        // The row says what it said before the save, not the name the form
        // still holds for another try.
        expect(row.textContent).toContain("Work");
        expect(row.textContent).not.toContain("Home");
        expect(row.textContent).toContain("Checking is paused until the password is updated.");
    });
});
