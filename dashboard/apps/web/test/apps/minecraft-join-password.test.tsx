// @vitest-environment jsdom

/**
 * What the card tells a player about the commands it just switched on.
 *
 * Turning the switch on does the whole job on the server; it does the opposite
 * to the player, who is now locked out and has no screen to read - the game
 * itself, with no in-game way to look up what to type. The modded project runs
 * as a data pack, so the only thing vanilla lets an unauthenticated player send
 * the server is a scoreboard value, and its own register command silently
 * accepts a bare call and sets the password to 1 rather than failing. Both facts
 * were read off a running server, so both must be on the card before the switch
 * is turned on, not discovered afterwards by someone already locked out.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MinecraftJoinPassword } from "@/app/(app)/apps/installed/[id]/minecraft-join-password";

vi.mock("@/app/(app)/apps/installed/[id]/minecraft-actions", () => ({
    projectFitsAction: vi.fn(),
    updateServerSettingsAction: vi.fn()
}));

afterEach(() => {
    cleanup();
});

describe("the modded project's commands", () => {
    it("names both commands and the silent-1 trap", () => {
        render(
            <MinecraftJoinPassword
                installedAppId="server-1"
                edition="java"
                projects=""
                software="FABRIC"
                playersOnline={0}
                onSaved={vi.fn()}
            />
        );

        expect(screen.getByText(/\/trigger register set 1234/)).toBeTruthy();
        expect(screen.getByText(/\/trigger login set 1234/)).toBeTruthy();
        expect(
            screen.getByText(/registers the password 1, and the next login says the password is wrong/)
        ).toBeTruthy();
    });

    it("says the password can only be a number", () => {
        render(
            <MinecraftJoinPassword
                installedAppId="server-1"
                edition="java"
                projects=""
                software="FABRIC"
                playersOnline={0}
                onSaved={vi.fn()}
            />
        );

        expect(screen.getByText(/password can only be a number/)).toBeTruthy();
    });
});

describe("the plugin project", () => {
    it("names the plugin rather than inventing its commands", () => {
        render(
            <MinecraftJoinPassword
                installedAppId="server-1"
                edition="java"
                projects=""
                software="PAPER"
                playersOnline={0}
                onSaved={vi.fn()}
            />
        );

        expect(screen.getByText(/documents on its Modrinth page/)).toBeTruthy();
        expect(screen.getAllByText("mylogin").length).toBeGreaterThan(0);
        expect(screen.queryByText(/\/trigger/)).toBeNull();
    });
});
