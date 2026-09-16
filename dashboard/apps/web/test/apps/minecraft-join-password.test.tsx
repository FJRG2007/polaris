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

import { joinGuardFor } from "@/lib/apps/minecraft/join-guard";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginState } from "@/lib/apps/minecraft/polaris-login-service";
import * as actions from "@/app/(app)/apps/installed/[id]/minecraft-actions";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as loginActions from "@/app/(app)/apps/installed/[id]/minecraft-login-actions";
import { MinecraftJoinPassword } from "@/app/(app)/apps/installed/[id]/minecraft-join-password";

vi.mock("@/app/(app)/apps/installed/[id]/minecraft-actions", () => ({
    projectFitsAction: vi.fn(),
    updateServerSettingsAction: vi.fn()
}));

const { confirm } = vi.hoisted(() => ({
    confirm: vi.fn(async (_options: { title: string; description?: string }) => true)
}));

vi.mock("@/components/confirm-dialog", () => ({ useConfirm: () => [confirm, null] }));

vi.mock("@/app/(app)/apps/installed/[id]/minecraft-login-actions", () => ({
    loginStateAction: vi.fn(),
    setLoginAction: vi.fn(),
    forgetLoginAction: vi.fn()
}));

const OFF: LoginState = {
    on: false,
    build: null,
    foreign: null,
    reachable: true,
    health: "waiting",
    seenAt: null,
    modVersion: null,
    players: []
};

beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(loginActions.loginStateAction).mockResolvedValue({ state: OFF });
    vi.mocked(loginActions.setLoginAction).mockResolvedValue({});
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
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

    it("says the server starts without it", async () => {
        for (const software of ["PAPER", "NEOFORGE"]) {
            cardFor(software);
            expect(await screen.findByText(/starts without it/), software).toBeTruthy();
        }
    });

    it("never claims the server refuses to start instead", async () => {
        for (const software of ["PAPER", "NEOFORGE"]) {
            cardFor(software);
            await screen.findByText(/starts without it/);
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

/**
 * Polaris's own login mod on the card.
 *
 * Offered where there is a build, and what Turn on installs once Polaris is
 * reachable and the server carries no login Polaris does not manage; a server
 * still on the Modrinth project is offered the switch instead. Once it is on it
 * is the guard the card describes: its commands, whether the server can still
 * reach Polaris, and a Turn off that takes the mod away rather than a Modrinth
 * project the server does not have.
 */
describe("Polaris login", () => {
    function neoforge(projects = "auth?") {
        render(
            <MinecraftJoinPassword
                installedAppId="server-1"
                edition="java"
                projects={projects}
                software="NEOFORGE"
                playersOnline={0}
                onSaved={vi.fn()}
            />
        );
    }

    const ON: LoginState = {
        ...OFF,
        on: true,
        build: "polaris-neoforge-1.21.4.jar",
        health: "ok",
        seenAt: new Date().toISOString(),
        modVersion: "0.1.0",
        players: [{ name: "Steve", createdAt: new Date().toISOString(), lastLoginAt: null }]
    };

    it("is offered where there is a build, and says who registers again", async () => {
        vi.mocked(loginActions.loginStateAction).mockResolvedValue({
            state: { ...OFF, build: "polaris-neoforge-1.21.4.jar" }
        });
        neoforge();
        expect(await screen.findByText("Use Polaris login")).toBeTruthy();
        expect(screen.getByText(/every player/)).toBeTruthy();
        // A server already on the Modrinth project keeps it until somebody switches.
        expect(screen.getByText(/\/trigger register set 1234/)).toBeTruthy();
    });

    it("says what it costs before it is turned on", async () => {
        vi.mocked(loginActions.loginStateAction).mockResolvedValue({
            state: { ...OFF, build: "polaris-neoforge-1.21.4.jar" }
        });
        neoforge();
        fireEvent.click(await screen.findByRole("button", { name: "Use Polaris login" }));
        await waitFor(() => expect(loginActions.setLoginAction).toHaveBeenCalled());
        const asked = confirm.mock.calls[0]?.[0].description ?? "";
        expect(asked).toMatch(/nobody can join and it does not start/);
        expect(asked).toMatch(/passwords kept by auth stop working/);
    });

    it("is what Turn on installs where there is a build and nothing is on", async () => {
        vi.mocked(loginActions.loginStateAction).mockResolvedValue({
            state: { ...OFF, build: "polaris-neoforge-1.21.4.jar" }
        });
        neoforge("");
        expect(await screen.findByText(/Uses Polaris login/)).toBeTruthy();
        expect(screen.queryByText(/\/trigger/)).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
        await waitFor(() =>
            expect(loginActions.setLoginAction).toHaveBeenCalledWith({
                installedAppId: "server-1",
                on: true
            })
        );
    });

    it("leaves a server with a login Polaris does not manage alone", async () => {
        vi.mocked(loginActions.loginStateAction).mockResolvedValue({
            state: { ...OFF, build: "polaris-neoforge-1.21.4.jar", foreign: "basic-login" }
        });
        neoforge("basic-login?");
        await screen.findByText(/which Polaris does not manage/);
        expect(screen.queryByText("Use Polaris login")).toBeNull();
        expect(screen.queryByText(/Uses Polaris login/)).toBeNull();
        expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
    });

    it("installs the Modrinth project where Polaris has no public address", async () => {
        vi.mocked(loginActions.loginStateAction).mockResolvedValue({
            state: { ...OFF, build: "polaris-neoforge-1.21.4.jar", reachable: false }
        });
        neoforge("");
        await screen.findByText(/starts without it/);
        expect(screen.queryByText(/Uses Polaris login/)).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
        await waitFor(() => expect(actions.projectFitsAction).toHaveBeenCalled());
        expect(loginActions.setLoginAction).not.toHaveBeenCalled();
    });

    it("is not offered without a build", async () => {
        neoforge();
        await screen.findByText(/starts without it/);
        expect(screen.queryByText("Use Polaris login")).toBeNull();
    });

    it("offers no Turn on beside a plugin server's own login", () => {
        render(
            <MinecraftJoinPassword
                installedAppId="server-1"
                edition="java"
                projects="simple-auth?"
                software="PAPER"
                playersOnline={0}
                onSaved={vi.fn()}
            />
        );
        expect(screen.getByText(/which Polaris does not manage/)).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
    });

    it("is never asked about on a plugin server", () => {
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
        expect(loginActions.loginStateAction).not.toHaveBeenCalled();
    });

    it("describes the mod, not the project, once it is on", async () => {
        vi.mocked(loginActions.loginStateAction).mockResolvedValue({ state: ON });
        neoforge("");
        expect(await screen.findByText(/\/register <password> <password>/)).toBeTruthy();
        expect(screen.getByText("Steve")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Reset Steve's password" })).toBeTruthy();
        expect(screen.queryByText(/\/trigger/)).toBeNull();
        expect(screen.getByText("On")).toBeTruthy();
    });

    it("says nobody can join when the server has gone quiet", async () => {
        vi.mocked(loginActions.loginStateAction).mockResolvedValue({
            state: { ...ON, health: "silent" }
        });
        neoforge("");
        expect(await screen.findByText(/nobody can join it/)).toBeTruthy();
    });

    it("turns the mod off, not a project, from Turn off", async () => {
        vi.mocked(loginActions.loginStateAction).mockResolvedValue({ state: ON });
        neoforge("");
        fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
        await waitFor(() =>
            expect(loginActions.setLoginAction).toHaveBeenCalledWith({
                installedAppId: "server-1",
                on: false
            })
        );
    });
});
