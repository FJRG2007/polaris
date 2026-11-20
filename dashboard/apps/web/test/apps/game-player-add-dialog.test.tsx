// @vitest-environment jsdom

/**
 * Adding a player tied to a Polaris account, the way an operator does it: find
 * the account, keep "wherever they are signed in", type the name, link, and be
 * done with the dialog.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@polaris/app-host/client", () => ({
    hostUi: {
        i18nProvider: { useClient: () => "browser", useLocale: () => "en-US" },
        copyButton: { CopyButton: () => null },
        accountInput: {
            AccountInput: (props: {
                value: string;
                onValueChange: (value: string) => void;
                onEnter: () => void;
                "aria-label"?: string;
            }) => (
                <input
                    aria-label={props["aria-label"]}
                    value={props.value}
                    onChange={(event) => props.onValueChange(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            props.onEnter();
                        }
                    }}
                />
            )
        }
    }
}));
vi.mock("@polaris-app/game-servers/src/screens/installed/minecraft-inventory-editor", () => ({
    InventoryEditor: () => null
}));
vi.mock("@polaris-app/game-servers/src/components/player-history", () => ({
    PlayerRecordPanel: () => null
}));
vi.mock("@polaris-app/game-servers/src/screens/installed/minecraft-actions", () => ({
    myAddressAction: async () => ({}),
    readPlayerRecordAction: async () => ({})
}));

const { PlayerAccessDialog } = await import(
    "@polaris-app/game-servers/src/screens/installed/minecraft-player-dialogs"
);

afterEach(cleanup);

function openAdd(overrides: Partial<Parameters<typeof PlayerAccessDialog>[0]> = {}) {
    const props = {
        edition: "java" as const,
        player: null,
        pending: false,
        error: null,
        onClose: vi.fn(),
        onSave: vi.fn(),
        onLookUp: async () => ({ userId: "u-demo", name: "demo" }),
        onLink: vi.fn(async () => undefined),
        ...overrides
    };
    render(<PlayerAccessDialog {...props} />);
    return props;
}

async function findAccount(query: string): Promise<void> {
    const account = screen.getByLabelText("Polaris username or email address");
    fireEvent.change(account, { target: { value: query } });
    fireEvent.keyDown(account, { key: "Enter" });
}

describe("Add a player tied to an account", () => {
    it("links once and leaves closing to the screen, never re-presenting the form", async () => {
        const props = openAdd();
        await findAccount("demo");
        const anywhere = await screen.findByRole("radio", {
            name: "Wherever they are signed in to Polaris"
        });
        fireEvent.click(anywhere);
        fireEvent.change(screen.getByLabelText("Player"), { target: { value: "DemoPlayer" } });
        fireEvent.click(screen.getByRole("button", { name: "Link" }));
        await waitFor(() => expect(props.onLink).toHaveBeenCalledTimes(1));
        expect(props.onLink).toHaveBeenCalledWith({
            username: "DemoPlayer",
            userId: "u-demo",
            followSignIns: true
        });
        // The old dialog swapped its confirm to "Done" over the very same form -
        // account, choice, username - which read as the form asked again.
        await waitFor(() => expect(screen.queryByRole("button", { name: "Done" })).toBeNull());
    });

    it("an invite link to hand over is all that is drawn, with Done closing", async () => {
        const props = openAdd({
            onLookUp: async () => ({ error: "Nobody has that email." }),
            onInvite: async () => ({ invite: { url: "https://polaris.example/invite/abc" } })
        });
        fireEvent.change(screen.getByLabelText("Player"), { target: { value: "DemoPlayer" } });
        await findAccount("demo@example.com");
        fireEvent.click(await screen.findByRole("button", { name: /demo@example\.com/ }));
        await screen.findByText("https://polaris.example/invite/abc");
        expect(screen.queryByLabelText("Player")).toBeNull();
        expect(screen.queryByLabelText("Polaris username or email address")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Done" }));
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    it("a found account that is linked on the spot closes through the screen, not a Done step", async () => {
        const onInvite = vi.fn(async () => ({ linked: true as const, told: true }));
        openAdd({ onLookUp: async () => ({ error: "Nobody has that email." }), onInvite });
        fireEvent.change(screen.getByLabelText("Player"), { target: { value: "DemoPlayer" } });
        await findAccount("demo@example.com");
        fireEvent.click(await screen.findByRole("button", { name: /demo@example\.com/ }));
        await waitFor(() => expect(onInvite).toHaveBeenCalledTimes(1));
        expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    });
});
