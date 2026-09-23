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
    grantPlayerAccessAction: vi.fn(async () => ({}))
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
    player: "Reckmy",
    address: "79.157.164.219",
    why: "Your account is registered to a different network. Ask the server's owner to add this one.",
    at: "2026-09-21T20:32:57.000Z"
};

function screenWith(refusals: PlayerRefusal[], changed = vi.fn()): void {
    render(
        <MinecraftPlayers
            installedAppId="server-1"
            status={STATUS}
            roster={{ ops: [], whitelist: ["Reckmy"], bans: [], whitelistEnforced: true }}
            rosterAsOf={null}
            access={{
                rules: [],
                refusals,
                links: [],
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
        const card = screen.getByText("Turned away recently").closest("div");
        if (!card) throw new Error("no card");
        expect(within(card).getByText("Reckmy")).toBeTruthy();
        expect(within(card).getByText(/arrived from 79\.157\.164\.219/)).toBeTruthy();
    });

    it("allows the address they actually arrived from", async () => {
        const changed = vi.fn();
        screenWith([REFUSAL], changed);
        await userEvent.click(screen.getByRole("button", { name: "Allow this address too" }));
        await waitFor(() =>
            expect(actions.grantPlayerAccessAction).toHaveBeenCalledWith({
                installedAppId: "server-1",
                username: "Reckmy",
                address: "79.157.164.219",
                note: "Added from a refused join"
            })
        );
        await waitFor(() => expect(changed).toHaveBeenCalled());
    });

    it("offers no button when the log never carried an address", () => {
        screenWith([{ ...REFUSAL, address: null }]);
        expect(screen.getByText(/an address the log did not carry/)).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Allow this address too" })).toBeNull();
    });
});
