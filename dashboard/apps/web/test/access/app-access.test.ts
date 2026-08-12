/**
 * Where a person lands, and which apps they are offered.
 *
 * The property that matters is the one nobody notices until it breaks: an
 * account whose role opens nothing still has to land somewhere. Sending everybody
 * to Drive - which is what the dashboard did before apps carried a permission -
 * bounces exactly those people between a page that turns them away and a redirect
 * back to it.
 *
 * Overview is offered to everybody who can open anything at all, and lands them,
 * which is why it heads every list here. For the account that can open nothing it
 * would be an empty grid, so it is withheld and the account page still answers.
 */

import { describe, expect, it } from "vitest";
import type { Permission } from "@polaris/core";
import { ACCOUNT_HOME, homePathFor, reachableAppIds, reachableAppNav, reachableApps } from "@/lib/app-access";

/** A person who holds exactly these permissions and is not an administrator. */
function holding(...permissions: Permission[]) {
    const held = new Set<Permission>(permissions);
    return { isAdmin: false, can: async (permission: Permission) => held.has(permission) };
}

const ADMIN = { isAdmin: true, can: async () => true };

describe("reachableAppIds", () => {
    it("offers only the apps the permissions open", async () => {
        expect(await reachableAppIds(holding("drive.read"))).toEqual(["overview", "drive"]);
        expect(await reachableAppIds(holding("tasks.read"))).toEqual(["overview", "tasks"]);
    });

    it("gives an administrator Management, and withholds it from everyone else", async () => {
        expect(await reachableAppIds(ADMIN)).toContain("admin");
        expect(await reachableAppIds(holding("drive.read", "deploy.read"))).not.toContain("admin");
    });

    it("opens Watch on the same permission as Apps, since it reports on them", async () => {
        expect(await reachableAppIds(holding("deploy.read"))).toEqual(["overview", "apps", "watch"]);
    });

    it("offers nothing to a role that grants nothing, Overview included", async () => {
        // Overview asks for no permission, so it would otherwise be the one app
        // an account that reaches nothing is handed - an empty grid.
        expect(await reachableAppIds(holding())).toEqual([]);
    });

    it("never offers the account section as an app - it is reached from the menu", async () => {
        expect(await reachableAppIds(ADMIN)).not.toContain("account");
    });
});

/**
 * Inbox stopped being an app of its own and became a subject of Management, which
 * only administrators can open - and `member` and `viewer` both hold `inbox.read`.
 * Without a door of their own they would keep the permission and lose every way to
 * use it, which is the regression these cover.
 */
describe("the Inbox door inside Management", () => {
    it("offers Management to a member, under Inbox's name and landing on it", async () => {
        const apps = await reachableApps(holding("inbox.read"));
        expect(apps.map((app) => app.id)).toEqual(["overview", "admin"]);
        const app = apps.find((entry) => entry.id === "admin");
        expect(app?.label).toBe("Inbox");
        expect(app?.href).toBe("/inbox");
    });

    it("keeps the member's one door out of the Overview they land on", async () => {
        // Their landing screen is the grid like everybody else's; what this
        // protects is that Inbox is still on the switcher behind it, since the
        // permission is the only thing they hold.
        expect(await homePathFor(holding("inbox.read"))).toBe("/overview");
        expect(await reachableAppIds(holding("inbox.read"))).toContain("admin");
    });

    it("keeps Management itself for an administrator", async () => {
        const app = (await reachableApps(ADMIN)).find((entry) => entry.id === "admin");
        expect(app?.label).toBe("Management");
        expect(app?.href).toBe("/admin");
    });

    it("marks the guest entry for the switcher, and only the guest one", async () => {
        expect(await reachableAppNav(holding("inbox.read"))).toEqual({
            ids: ["overview", "admin"],
            guestIds: ["admin"]
        });
        expect((await reachableAppNav(ADMIN)).guestIds).toEqual([]);
    });

    it("gives nothing to somebody who holds neither", async () => {
        expect(await reachableAppIds(holding("drive.read"))).not.toContain("admin");
    });
});

describe("homePathFor", () => {
    it("lands on the Overview, whichever apps the person holds", async () => {
        expect(await homePathFor(holding("drive.read", "tasks.read"))).toBe("/overview");
        expect(await homePathFor(holding("tasks.read"))).toBe("/overview");
    });

    it("lands an account that opens nothing on its own account page", async () => {
        expect(await homePathFor(holding())).toBe(ACCOUNT_HOME);
    });
});
