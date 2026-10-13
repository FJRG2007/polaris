// @vitest-environment jsdom

/**
 * A bag opened while its player was away shows the last copy Polaris kept. When
 * the screen behind sees them join, the editor turns to the live bag on its own,
 * without being closed and opened again - and reads nothing while they are away.
 */

import "@/components/app-host/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const COPY = { reading: { items: [], live: false, takenAt: null } };
const LIVE = { reading: { items: [], live: true, takenAt: null } };
const readInventory = vi.fn(async () => COPY);

vi.mock("@polaris-app/game-servers/src/screens/installed/minecraft-actions", () => ({
    readPlayerInventoryAction: readInventory,
    recentItemsAction: async () => ({ items: [] }),
    pendingActionsAction: async () => ({ pending: [] }),
    givePlayerItemAction: async () => ({ queued: true }),
    clearPlayerItemAction: async () => ({ queued: true }),
    setInventorySlotAction: async () => ({ queued: true }),
    clearInventorySlotAction: async () => ({}),
    moveInventorySlotAction: async () => ({}),
    cancelQueuedActionAction: async () => ({}),
    enchantContextAction: async () => ({})
}));

const { InventoryEditor } = await import(
    "@polaris-app/game-servers/src/screens/installed/minecraft-inventory-editor"
);

afterEach(() => {
    cleanup();
    readInventory.mockReset();
    readInventory.mockImplementation(async () => COPY);
});

function editor(online: boolean) {
    return (
        <InventoryEditor
            installedAppId="app"
            player="PlayerOne"
            editable
            online={online}
            onChanged={() => undefined}
        />
    );
}

describe("a bag read from a copy", () => {
    it("turns live when its player joins, without reopening", async () => {
        const view = render(editor(false));
        expect(await screen.findByText("From a copy")).toBeTruthy();
        expect(readInventory).toHaveBeenCalledTimes(1);

        readInventory.mockImplementation(async () => LIVE);
        view.rerender(editor(true));
        expect(await screen.findByText("Live")).toBeTruthy();
        expect(screen.queryByText("From a copy")).toBeNull();
    });

    it("reads nothing more while they stay away", async () => {
        const view = render(editor(false));
        await screen.findByText("From a copy");
        view.rerender(editor(false));
        await waitFor(() => expect(readInventory).toHaveBeenCalledTimes(1));
    });
});
