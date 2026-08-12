/**
 * Which Overview cards an account is offered.
 *
 * Two independent tests, and the difference matters. The permission answers
 * whether this account may know: no `drive.read`, no storage card, on the grid or
 * in the customize panel. The feature answers whether there is anything to know:
 * an instance that runs no game server is not offered a card about game servers,
 * however much permission the reader holds.
 */

import { describe, expect, it } from "vitest";
import type { Permission } from "@polaris/core";
import { availableOverviewWidgets, OVERVIEW_WIDGETS } from "@/lib/overview/catalog";

function holding(...permissions: Permission[]) {
    const held = new Set<Permission>(permissions);
    return { isAdmin: false, can: async (permission: Permission) => held.has(permission) };
}

/** Cards that ask for nothing, which everybody signed in is offered. */
const FREE = OVERVIEW_WIDGETS.filter((widget) => !widget.permission && !widget.requires).map((widget) => widget.id);

describe("availableOverviewWidgets", () => {
    it("offers the cards that ask for nothing to an account that holds nothing", async () => {
        expect(await availableOverviewWidgets(holding())).toEqual(FREE);
    });

    it("adds a card once its permission is held, and not before", async () => {
        expect(await availableOverviewWidgets(holding())).not.toContain("storage");
        expect(await availableOverviewWidgets(holding("drive.read"))).toContain("storage");
    });

    it("withholds the game servers card until one is installed, permission or not", async () => {
        expect(await availableOverviewWidgets(holding("games.read"))).not.toContain("games");
        expect(await availableOverviewWidgets({ ...holding("games.read"), features: { games: false } })).not.toContain(
            "games"
        );
        expect(await availableOverviewWidgets({ ...holding("games.read"), features: { games: true } })).toContain(
            "games"
        );
    });

    it("still withholds it from somebody without the permission on an instance that runs them", async () => {
        expect(await availableOverviewWidgets({ ...holding("drive.read"), features: { games: true } })).not.toContain(
            "games"
        );
    });

    it("keeps the catalogue order, so the grid is arranged the way it is written", async () => {
        const offered = await availableOverviewWidgets({
            ...holding("drive.read", "deploy.read", "tasks.read", "games.read"),
            features: { games: true }
        });
        const catalogue = OVERVIEW_WIDGETS.map((widget) => widget.id);
        expect(offered).toEqual(catalogue.filter((id) => offered.includes(id)));
    });
});
