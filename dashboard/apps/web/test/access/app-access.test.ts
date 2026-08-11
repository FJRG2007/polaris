/**
 * Where a person lands, and which apps they are offered.
 *
 * The property that matters is the one nobody notices until it breaks: an
 * account whose role opens nothing still has to land somewhere. Sending everybody
 * to Drive - which is what the dashboard did before apps carried a permission -
 * bounces exactly those people between a page that turns them away and a redirect
 * back to it.
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
        expect(await reachableAppIds(holding("drive.read"))).toEqual(["drive"]);
        expect(await reachableAppIds(holding("tasks.read"))).toEqual(["tasks"]);
    });

    it("gives an administrator Management, and withholds it from everyone else", async () => {
        expect(await reachableAppIds(ADMIN)).toContain("admin");
        expect(await reachableAppIds(holding("drive.read", "deploy.read"))).not.toContain("admin");
    });

    it("opens Watch on the same permission as Apps, since it reports on them", async () => {
        expect(await reachableAppIds(holding("deploy.read"))).toEqual(["apps", "watch"]);
    });

    it("offers nothing to a role that grants nothing", async () => {
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
        const [app, ...rest] = await reachableApps(holding("inbox.read"));
        expect(rest).toEqual([]);
        expect(app?.id).toBe("admin");
        expect(app?.label).toBe("Inbox");
        expect(app?.href).toBe("/inbox");
    });

    it("lands a member on Inbox rather than on a page that turns them away", async () => {
        expect(await homePathFor(holding("inbox.read"))).toBe("/inbox");
    });

    it("keeps Management itself for an administrator", async () => {
        const app = (await reachableApps(ADMIN)).find((entry) => entry.id === "admin");
        expect(app?.label).toBe("Management");
        expect(app?.href).toBe("/admin");
    });

    it("marks the guest entry for the switcher, and only the guest one", async () => {
        expect(await reachableAppNav(holding("inbox.read"))).toEqual({ ids: ["admin"], guestIds: ["admin"] });
        expect((await reachableAppNav(ADMIN)).guestIds).toEqual([]);
    });

    it("gives nothing to somebody who holds neither", async () => {
        expect(await reachableAppIds(holding("drive.read"))).not.toContain("admin");
    });
});

describe("homePathFor", () => {
    it("lands on the first app the person can open", async () => {
        expect(await homePathFor(holding("drive.read", "tasks.read"))).toBe("/drive");
        // No Drive: the next app in the registry order is where they belong.
        expect(await homePathFor(holding("tasks.read"))).toBe("/tasks");
    });

    it("lands an account that opens nothing on its own account page", async () => {
        expect(await homePathFor(holding())).toBe(ACCOUNT_HOME);
    });
});
