// @vitest-environment jsdom

/**
 * What the owner sees about somebody the server turned away.
 *
 * The player was told "ask the server's owner to add this one" and then thrown
 * out of the game. This card is the only place that sentence reaches the owner,
 * so it carries the address the player actually arrived from and the one button
 * that answers it - a home connection that was given a new address overnight is
 * most of these, and retyping the address into a form is not an answer.
 */

import userEvent from "@testing-library/user-event";
import type { MinecraftStatus } from "@polaris-app/game-servers/src/lib/minecraft/service";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { PlayerRefusal } from "@polaris-app/game-servers/src/lib/minecraft/player-access";
import { MinecraftPlayers } from "@polaris-app/game-servers/src/screens/installed/minecraft-players";
import * as actions from "@polaris-app/game-servers/src/screens/installed/minecraft-actions";
// The dashboard's pieces the screen takes, as the layout provides them.
import "@/components/app-host/client";

vi.mock("@polaris-app/game-servers/src/screens/installed/minecraft-actions", () => ({
    grantPlayerAccessAction: vi.fn(async () => ({})),
    dismissRefusalAction: vi.fn(async () => ({}))
}));
vi.mock("@polaris-app/game-servers/src/screens/installed/minecraft-login-actions", () => ({
    loginStateAction: vi.fn(),
    setLoginAction: vi.fn(),
    forgetLoginAction: vi.fn()
}));
// Reached through the row dialogs' imports; nothing here signs anybody in.
vi.mock("@/lib/session", () => ({}));

const STATUS: MinecraftStatus = {
    edition: "java",
    running: true,
    answering: true,
    players: { online: 0, max: 20, players: [] },
    address: "mc.example.com",
    message: null,
    cpuPercent: null,
    memUsedBytes: null,
    memTotalBytes: null
};

const REFUSAL: PlayerRefusal = {
    player: "Grumm",
    address: "198.51.100.219",
    why: "Your account is registered to a different network. Ask the server's owner to add this one.",
    at: "2026-09-21T20:32:57.000Z"
};

function screenWith(
    refusals: PlayerRefusal[],
    changed = vi.fn(),
    links: { username: string; userId: string; name: string; followSignIns: boolean }[] = []
): void {
    render(
        <MinecraftPlayers
            installedAppId="server-1"
            status={STATUS}
            roster={{ ops: [], whitelist: ["Grumm"], bans: [], whitelistEnforced: true }}
            rosterAsOf={null}
            access={{
                rules: [],
                refusals,
                links,
                bindAddresses: true,
                addressesAvailable: true,
                edition: "java"
            }}
            sessions={[]}
            seen={{}}
            now={Date.now()}
            timeouts={[]}
            levels={{}}
            lastLevels={{}}
            passwords={null}
            pending={[]}
            onChanged={changed}
        />
    );
}

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe("turned away recently", () => {
    it("says nothing on a server that has turned nobody away", () => {
        screenWith([]);
        expect(screen.queryByText("Turned away recently")).toBeNull();
    });

    it("names who it was and where they came from", () => {
        screenWith([REFUSAL]);
        // Scoped to the card: the same name is also down in the players table,
        // which is the row this card exists to explain.
        const card = screen.getByText("Turned away recently").closest("div")?.parentElement;
        if (!card) throw new Error("no card");
        expect(within(card).getByText("Grumm")).toBeTruthy();
        expect(within(card).getByText(/arrived from 198\.51\.100\.219/)).toBeTruthy();
    });

    it("allows the address they actually arrived from", async () => {
        const changed = vi.fn();
        screenWith([REFUSAL], changed);
        await userEvent.click(screen.getByRole("button", { name: "Allow this address too" }));
        await waitFor(() =>
            expect(actions.grantPlayerAccessAction).toHaveBeenCalledWith({
                installedAppId: "server-1",
                username: "Grumm",
                address: "198.51.100.219",
                note: "Added from a refused join"
            })
        );
        await waitFor(() => expect(changed).toHaveBeenCalled());
    });

    it("clears one when the owner is done with it", async () => {
        const changed = vi.fn();
        screenWith(
            [REFUSAL, { ...REFUSAL, player: "Dinnerbone", at: "2026-09-21T21:00:00.000Z" }],
            changed
        );
        const [first] = screen.getAllByRole("button", { name: "Clear" });
        await userEvent.click(first!);
        expect(screen.queryByText("Grumm", { selector: "span" })).toBeNull();
        await waitFor(() =>
            expect(actions.dismissRefusalAction).toHaveBeenCalledWith("server-1", {
                player: "Grumm",
                at: REFUSAL.at
            })
        );
        await waitFor(() => expect(changed).toHaveBeenCalled());
        expect(screen.getByText("Turned away recently")).toBeTruthy();
    });

    it("clears them all at once, and puts them back if that could not be saved", async () => {
        vi.mocked(actions.dismissRefusalAction).mockResolvedValueOnce({
            error: "Could not clear that"
        });
        screenWith([REFUSAL, { ...REFUSAL, player: "Dinnerbone", at: "2026-09-21T21:00:00.000Z" }]);
        await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
        await waitFor(() =>
            expect(actions.dismissRefusalAction).toHaveBeenCalledWith("server-1", "all")
        );
        await waitFor(() => expect(screen.getByText("Turned away recently")).toBeTruthy());
        expect(screen.getByText("Could not clear that")).toBeTruthy();
    });

    it("offers no button when the log never carried an address", () => {
        screenWith([{ ...REFUSAL, address: null }]);
        expect(screen.getByText(/an address the log did not carry/)).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Allow this address too" })).toBeNull();
    });

    it("says why a player who follows their sign-ins was turned away, and how they get in", () => {
        // The report: a linked player's refusal said a home connection changes
        // address now and then - true of a typed address, and no help for one
        // that follows a Polaris account's sign-ins, which was the case.
        screenWith([REFUSAL], vi.fn(), [
            { username: "Grumm", userId: "u-1", name: "Grumm M.", followSignIns: true }
        ]);
        expect(
            screen.getByText(
                "Grumm's Polaris account is not signed in from this address. Opening Polaris on that connection lets them in, or allow it here for good."
            )
        ).toBeTruthy();
        expect(screen.queryByText(/given a new address by its provider/)).toBeNull();
        expect(screen.getByRole("button", { name: "Allow this address too" })).toBeTruthy();
    });
});
