// @vitest-environment jsdom

/**
 * Why a player went, in the players table.
 *
 * An offline player's row says why they last went - timed out, kicked, banned -
 * and somebody the server turned away at the door is listed with why, so an
 * operator asked "why can't I get in?" reads the answer off the row. The
 * server's own words are on the label for whoever wants the detail.
 */

import "@/components/app-host/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { MinecraftStatus } from "@polaris-app/game-servers/src/lib/minecraft/service";
import type { PlayerSessionEvent } from "@polaris-app/game-servers/src/lib/minecraft/sessions";
import { MinecraftPlayers } from "@polaris-app/game-servers/src/screens/installed/minecraft-players";

vi.mock("@polaris-app/game-servers/src/screens/installed/minecraft-actions", () => ({}));
vi.mock("@/lib/session", () => ({}));
vi.mock("@polaris-app/game-servers/src/screens/installed/minecraft-login-actions", () => ({
    loginStateAction: vi.fn(),
    setLoginAction: vi.fn(),
    forgetLoginAction: vi.fn()
}));

afterEach(cleanup);

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

const SESSIONS: PlayerSessionEvent[] = [
    { name: "Alice", kind: "join", at: "2026-08-08T10:00:00.000Z", address: "203.0.113.9" },
    {
        name: "Alice",
        kind: "leave",
        at: "2026-08-08T10:30:00.000Z",
        address: null,
        reason: { kind: "timeout", raw: "Timed out" }
    },
    {
        name: "Mallory",
        kind: "refused",
        at: "2026-08-08T10:31:00.000Z",
        address: null,
        reason: { kind: "whitelist", raw: "You are not white-listed on this server!" }
    }
];

function rowOf(name: string): HTMLElement {
    const cell = screen.getAllByText(name)[0]!;
    return cell.closest("tr") ?? cell.closest("li") ?? cell.parentElement!;
}

describe("the players table", () => {
    it("says why an offline player last went, with the server's own words", () => {
        render(
            <MinecraftPlayers
                installedAppId="server-1"
                status={STATUS}
                roster={{ ops: [], whitelist: ["Alice"], bans: [], whitelistEnforced: true }}
                rosterAsOf={null}
                access={{
                    rules: [],
                    bindAddresses: true,
                    addressesAvailable: true,
                    edition: "java"
                }}
                sessions={SESSIONS}
                seen={{}}
                now={Date.parse("2026-08-08T11:00:00.000Z")}
                timeouts={[]}
                levels={{}}
                lastLevels={{}}
                pending={[]}
                passwords={null}
                onChanged={vi.fn()}
            />
        );
        const alice = rowOf("Alice");
        const label = within(alice).getByTitle("The server said: Timed out");
        expect(label.textContent).toContain("Timed out");

        const mallory = rowOf("Mallory");
        expect(within(mallory).getByText("Turned away")).toBeTruthy();
        expect(
            within(mallory).getByTitle("The server said: You are not white-listed on this server!")
                .textContent
        ).toContain("Not whitelisted");
        // Never in the game, so no "last on" time for a visit that never was.
        expect(within(mallory).queryByTitle(/history/i)).toBeNull();
    });
});
