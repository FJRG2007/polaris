// @vitest-environment jsdom

/**
 * Polaris login passwords in the players table.
 *
 * The table is where an operator already looks somebody up, so it is where they
 * see whether that person has a password and reset it - not a second list of the
 * same names on another screen. A server that does not ask for passwords says
 * nothing about them, and resetting one takes the manage grant the table itself
 * does not need.
 */

import userEvent from "@testing-library/user-event";
import type { MinecraftStatus } from "@polaris-app/game-servers/src/lib/minecraft/service";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MinecraftPlayers } from "@polaris-app/game-servers/src/screens/installed/minecraft-players";
import * as loginActions from "@polaris-app/game-servers/src/screens/installed/minecraft-login-actions";
// The dashboard's pieces the screen takes, as the layout provides them.
import "@/components/app-host/client";

vi.mock("@polaris-app/game-servers/src/screens/installed/minecraft-actions", () => ({}));
// Reached through the row dialogs' imports; nothing here signs anybody in.
vi.mock("@/lib/session", () => ({}));

vi.mock("@polaris-app/game-servers/src/screens/installed/minecraft-login-actions", () => ({
    loginStateAction: vi.fn(),
    setLoginAction: vi.fn(),
    forgetLoginAction: vi.fn()
}));

const STATUS: MinecraftStatus = {
    edition: "java",
    running: true,
    answering: true,
    players: { online: 1, max: 20, players: ["Steve"] },
    address: "mc.example.com",
    message: null,
    cpuPercent: null,
    memUsedBytes: null,
    memTotalBytes: null
};

beforeEach(() => {
    vi.mocked(loginActions.forgetLoginAction).mockResolvedValue({});
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

function table(props: {
    passwords: { name: string; lastLoginAt: string | null }[] | null;
    canResetPasswords?: boolean;
    onPasswordsChanged?: () => void;
    levels?: Record<string, number>;
    lastLevels?: Record<string, { level: number; at: string }>;
}) {
    render(
        <MinecraftPlayers
            installedAppId="server-1"
            status={STATUS}
            roster={{ ops: [], whitelist: ["Alex"], bans: [], whitelistEnforced: true }}
            rosterAsOf={null}
            access={{ rules: [], bindAddresses: true, addressesAvailable: true, edition: "java" }}
            sessions={[]}
            seen={{}}
            now={Date.now()}
            timeouts={[]}
            levels={{}}
            lastLevels={{}}
            pending={[]}
            onChanged={vi.fn()}
            {...props}
        />
    );
}

function rowOf(name: string): HTMLElement {
    const cell = screen.getByTitle(name);
    const row = cell.closest("tr");
    if (!row) throw new Error(`no row for ${name}`);
    return row;
}

describe("passwords in the players table", () => {
    it("says who has one and who does not, and lists somebody known only by it", () => {
        table({
            passwords: [
                { name: "steve", lastLoginAt: "2026-09-17T10:00:00.000Z" },
                { name: "Reckmy", lastLoginAt: null }
            ]
        });
        expect(within(rowOf("Steve")).getByText("password set")).toBeTruthy();
        expect(within(rowOf("Reckmy")).getByText("password set")).toBeTruthy();
        expect(within(rowOf("Alex")).getByText("no password yet")).toBeTruthy();
    });

    it("says nothing about passwords on a server that does not ask for them", () => {
        table({ passwords: null });
        expect(screen.queryByText("password set")).toBeNull();
        expect(screen.queryByText("no password yet")).toBeNull();
    });

    it("resets one from the row's menu, after asking", async () => {
        const changed = vi.fn();
        table({
            passwords: [{ name: "Steve", lastLoginAt: null }],
            canResetPasswords: true,
            onPasswordsChanged: changed
        });
        const user = userEvent.setup();
        await user.click(within(rowOf("Steve")).getByRole("button", { name: "More for Steve" }));
        await user.click(await screen.findByRole("menuitem", { name: /Reset password/ }));
        const dialog = await screen.findByRole("dialog");
        await user.click(within(dialog).getByRole("button", { name: "Reset password" }));
        await waitFor(() =>
            expect(loginActions.forgetLoginAction).toHaveBeenCalledWith({
                installedAppId: "server-1",
                player: "Steve"
            })
        );
        await waitFor(() => expect(changed).toHaveBeenCalled());
    });

    it("offers no reset without the grant, or to somebody with no password", async () => {
        table({ passwords: [{ name: "Steve", lastLoginAt: null }], canResetPasswords: false });
        const user = userEvent.setup();
        await user.click(within(rowOf("Steve")).getByRole("button", { name: "More for Steve" }));
        await screen.findByRole("menu");
        expect(screen.queryByRole("menuitem", { name: /Reset password/ })).toBeNull();
    });
});

describe("levels in the players table", () => {
    it("shows the live level of somebody on, and the last one of somebody away", () => {
        table({
            passwords: null,
            levels: { Steve: 30 },
            lastLevels: {
                steve: { level: 12, at: "2026-09-16T10:00:00.000Z" },
                alex: { level: 7, at: "2026-09-15T10:00:00.000Z" }
            }
        });
        expect(within(rowOf("Steve")).getByText("30")).toBeTruthy();
        const away = within(rowOf("Alex")).getByText("7");
        expect(away.getAttribute("title")).toContain("Level 7 when last seen");
    });
});
