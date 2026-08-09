/**
 * The one panel a bag is looked at and changed from.
 *
 * What is being checked is what it draws before anything has been read: the grid,
 * the palette, and both directions an item can go. Every one of those needs a
 * round trip to the game server to fill in, and a panel that waits for them is a
 * dialog that is a spinner for a second - which is the dialog somebody presses
 * twice.
 *
 * The server actions are stood in for because importing them pulls the whole
 * server environment into a render test; what they answer is not what this is
 * about.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/(app)/apps/installed/[id]/minecraft-actions", () => ({
    readPlayerInventoryAction: async () => ({ reading: { items: [], live: false, takenAt: null } }),
    recentItemsAction: async () => ({ items: [] }),
    pendingActionsAction: async () => ({ pending: [] }),
    givePlayerItemAction: async () => ({ queued: true }),
    clearPlayerItemAction: async () => ({ queued: true }),
    setInventorySlotAction: async () => ({ queued: true }),
    clearInventorySlotAction: async () => ({}),
    moveInventorySlotAction: async () => ({}),
    cancelQueuedActionAction: async () => ({})
}));

const { InventoryEditor } = await import("@/app/(app)/apps/installed/[id]/minecraft-inventory-editor");

describe("InventoryEditor", () => {
    it("draws the whole panel before any read has landed", () => {
        const markup = renderToStaticMarkup(
            <InventoryEditor installedAppId="id" player="FJRG2007" editable onChanged={() => {}} />
        );
        expect(markup).toContain("Bag");
        expect(markup).toContain("Hotbar");
        expect(markup).toContain("Nothing in it.");
        expect(markup).toContain("Search items");
    });

    it("offers giving and taking from the same panel", () => {
        // The two used to be separate screens, and taking an item off somebody who
        // was not on the server was not offered at all.
        const markup = renderToStaticMarkup(
            <InventoryEditor installedAppId="id" player="FJRG2007" editable onChanged={() => {}} />
        );
        expect(markup).toContain("Save it for their next join");
        expect(markup).toContain("Take it when they join");
    });
});
