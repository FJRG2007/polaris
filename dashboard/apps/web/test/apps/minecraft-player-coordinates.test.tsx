// @vitest-environment jsdom

/**
 * Where a player is and where to send them, as one screen.
 *
 * Pinned: opening it reads the coordinates and moves nobody; the teleport below
 * them goes to typed coordinates or to another player only when its button is
 * pressed; and a screen that is not offered the teleport does not draw it.
 */

import "@/components/app-host/client";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const readPosition = vi.fn(async () => ({
    position: { x: 10.5, y: 64, z: -220.25, dimension: "minecraft:the_nether" }
}));

vi.mock("@polaris-app/game-servers/src/screens/installed/minecraft-actions", () => ({
    readPlayerPositionAction: readPosition
}));

const { LocationDialog } = await import(
    "@polaris-app/game-servers/src/screens/installed/minecraft-player-dialogs"
);

afterEach(() => {
    cleanup();
    readPosition.mockClear();
});

function renderDialog(withTeleport = true) {
    const onTeleport = vi.fn();
    render(
        <LocationDialog
            installedAppId="app"
            player="PlayerOne"
            teleport={
                withTeleport ? { others: ["PlayerTwo"], pending: false, onTeleport } : undefined
            }
            onClose={() => undefined}
        />
    );
    return onTeleport;
}

describe("a player's coordinates", () => {
    it("shows where they are and the world, and moves nobody", async () => {
        const onTeleport = renderDialog();
        expect(await screen.findByText(/Nether/)).toBeTruthy();
        expect(readPosition).toHaveBeenCalledWith("app", "PlayerOne");
        expect(onTeleport).not.toHaveBeenCalled();
    });

    it("teleports them to typed coordinates only when asked", async () => {
        const user = userEvent.setup();
        const onTeleport = renderDialog();
        await screen.findByText(/Nether/);
        const button = screen.getByRole("button", { name: "Teleport" });
        expect((button as HTMLButtonElement).disabled).toBe(true);
        await user.type(screen.getByLabelText("Player or coordinates"), "100 64 -220");
        expect(onTeleport).not.toHaveBeenCalled();
        await user.click(button);
        expect(onTeleport).toHaveBeenCalledWith("100 64 -220");
    });

    it("teleports them to another player who is on", async () => {
        const user = userEvent.setup();
        const onTeleport = renderDialog();
        await user.click(await screen.findByRole("button", { name: "PlayerTwo" }));
        await user.click(screen.getByRole("button", { name: "Teleport" }));
        expect(onTeleport).toHaveBeenCalledWith("PlayerTwo");
    });

    it("draws no teleport where it is not offered", async () => {
        renderDialog(false);
        await screen.findByText(/Nether/);
        expect(screen.queryByRole("button", { name: "Teleport" })).toBeNull();
    });
});
