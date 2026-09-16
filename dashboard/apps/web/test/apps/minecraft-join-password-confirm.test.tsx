// @vitest-environment jsdom

/**
 * The card's switches, with the real confirmation dialog.
 *
 * Both switches ask before restarting the server. They used to ask from inside a
 * React transition, which holds every state update until the transition ends -
 * so the dialog never appeared and the button spun forever. A test that replaces
 * the dialog cannot see that, which is why this one does not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as actions from "@/app/(app)/apps/installed/[id]/minecraft-actions";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as loginActions from "@/app/(app)/apps/installed/[id]/minecraft-login-actions";
import { MinecraftJoinPassword } from "@/app/(app)/apps/installed/[id]/minecraft-join-password";

vi.mock("@/app/(app)/apps/installed/[id]/minecraft-actions", () => ({
    projectFitsAction: vi.fn(),
    updateServerSettingsAction: vi.fn()
}));

vi.mock("@/app/(app)/apps/installed/[id]/minecraft-login-actions", () => ({
    loginStateAction: vi.fn(),
    setLoginAction: vi.fn(),
    forgetLoginAction: vi.fn()
}));

const OFF = {
    on: false,
    build: "polaris-neoforge-1.21.4.jar",
    health: "waiting" as const,
    seenAt: null,
    modVersion: null,
    players: []
};

beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(loginActions.loginStateAction).mockResolvedValue({ state: OFF });
    vi.mocked(loginActions.setLoginAction).mockResolvedValue({});
    vi.mocked(actions.updateServerSettingsAction).mockResolvedValue({});
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

function card(software: string, projects: string) {
    render(
        <MinecraftJoinPassword
            installedAppId="server-1"
            edition="java"
            projects={projects}
            software={software}
            playersOnline={0}
            onSaved={vi.fn()}
        />
    );
}

describe("asking before a restart", () => {
    it("shows the dialog for Polaris login, and switches on its answer", async () => {
        card("NEOFORGE", "auth?");
        fireEvent.click(await screen.findByRole("button", { name: "Use Polaris login" }));
        const dialog = await screen.findByRole("dialog");
        fireEvent.click(within(dialog).getByRole("button", { name: "Use Polaris login" }));
        await waitFor(() =>
            expect(loginActions.setLoginAction).toHaveBeenCalledWith({
                installedAppId: "server-1",
                on: true
            })
        );
    });

    it("shows the dialog for Turn off", async () => {
        card("PAPER", "simple-login?");
        fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
        fireEvent.click(await screen.findByRole("button", { name: "Turn off and restart" }));
        await waitFor(() => expect(actions.updateServerSettingsAction).toHaveBeenCalled());
    });

    it("says so when the switch fails, instead of spinning", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.mocked(loginActions.setLoginAction).mockRejectedValue(
            new Error("server action not found")
        );
        card("NEOFORGE", "auth?");
        fireEvent.click(await screen.findByRole("button", { name: "Use Polaris login" }));
        const dialog = await screen.findByRole("dialog");
        fireEvent.click(within(dialog).getByRole("button", { name: "Use Polaris login" }));
        expect(await screen.findByText(/Polaris did not answer/)).toBeTruthy();
    });
});
