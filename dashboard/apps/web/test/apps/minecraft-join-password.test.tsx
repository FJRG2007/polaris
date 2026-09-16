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
import { joinGuardFor } from "@/lib/apps/minecraft/join-guard";
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
            screen.getByText(
                /registers the password 1, and the next login says the password is wrong/
            )
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
        // Read from the module rather than written out, because the point of the
        // assertion is that the card names whatever is actually seeded - a slug
        // repeated here would keep passing after the two had drifted apart.
        expect(screen.getAllByText(joinGuardFor("PAPER")!.slug).length).toBeGreaterThan(0);
        expect(screen.queryByText(/\/trigger/)).toBeNull();
    });
});

/**
 * What the card promises about a release the project has no build for.
 *
 * The entry is seeded optional, so the image skips it and starts the server
 * without it. The card used to say the opposite - that the server would say so
 * on startup rather than start without it - which was true while the entry was
 * required and became false the moment it stopped being. That is the worst
 * direction for this particular sentence to be wrong in: it is a security switch,
 * the screen says On either way, and somebody reading that line would have no
 * reason to go and check.
 */
describe("what the card says happens when there is no build", () => {
    function cardFor(software: string) {
        cleanup();
        render(
            <MinecraftJoinPassword
                installedAppId="server-1"
                edition="java"
                projects=""
                software={software}
                playersOnline={0}
                onSaved={vi.fn()}
            />
        );
    }

    it("says the server starts without it", () => {
        for (const software of ["PAPER", "NEOFORGE"]) {
            cardFor(software);
            expect(screen.getByText(/starts without it/), software).toBeTruthy();
        }
    });

    it("never claims the server refuses to start instead", () => {
        for (const software of ["PAPER", "NEOFORGE"]) {
            cardFor(software);
            expect(screen.queryByText(/rather than starting without it/), software).toBeNull();
        }
    });

    it("tells the reader where to confirm it actually installed", () => {
        // The cost of seeding it optional is a screen that can say On while
        // nothing was installed. The only honest answer is to say where the
        // server's own answer is.
        cardFor("PAPER");
        expect(screen.getByText(/check the Mods screen/)).toBeTruthy();
    });
});
