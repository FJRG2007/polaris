// @vitest-environment jsdom

/**
 * Editing a player saves only what changed.
 *
 * Pinned: an ARK player's edit opens with Save off, a new name turns it on, and
 * the old name typed back turns it off again - the row it would save is the one
 * already stored. Adding a player is not an edit and needs only a valid id.
 */

import "@/components/app-host/client";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@polaris-app/game-servers/src/screens/installed/ark-actions", () => ({}));

const { ArkPlayerDialog } =
    await import("@polaris-app/game-servers/src/screens/installed/ark-player-dialogs");

afterEach(cleanup);

const STEAM_ID = "76561198000000001";

function renderDialog(player: { steamId: string; label: string } | null) {
    const onSave = vi.fn();
    render(
        <ArkPlayerDialog
            player={player}
            pending={false}
            error={null}
            onClose={() => undefined}
            onSave={onSave}
        />
    );
    return onSave;
}

describe("editing an ARK player", () => {
    it("keeps Save off until the name differs from the stored one", async () => {
        const user = userEvent.setup();
        renderDialog({ steamId: STEAM_ID, label: "Rex" });
        const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save" });
        expect(save.disabled).toBe(true);

        const name = screen.getByDisplayValue("Rex");
        await user.type(name, "y");
        expect(save.disabled).toBe(false);

        await user.type(name, "{Backspace}");
        expect(save.disabled).toBe(true);

        await user.type(name, "  ");
        expect(save.disabled).toBe(true);
    });

    it("lets a new player be added once the id is valid", async () => {
        const user = userEvent.setup();
        renderDialog(null);
        const add = screen.getByRole<HTMLButtonElement>("button", { name: "Add player" });
        expect(add.disabled).toBe(true);
        await user.type(screen.getByPlaceholderText("76561198000000000"), STEAM_ID);
        expect(add.disabled).toBe(false);
    });
});
