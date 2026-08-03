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
import { ACCOUNT_HOME, homePathFor, reachableAppIds } from "@/lib/app-access";

/** A person who holds exactly these permissions and is not an administrator. */
function holding(...permissions: Permission[]) {
    const held = new Set<Permission>(permissions);
    return { isAdmin: false, can: async (permission: Permission) => held.has(permission) };
}

const ADMIN = { isAdmin: true, can: async () => true };

describe("reachableAppIds", () => {
    it("offers only the apps the permissions open", async () => {
        expect(await reachableAppIds(holding("drive.read"))).toEqual(["drive"]);
        expect(await reachableAppIds(holding("tasks.read", "inbox.read"))).toEqual(["tasks", "inbox"]);
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
