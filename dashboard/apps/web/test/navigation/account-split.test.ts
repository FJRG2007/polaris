/**
 * The profile and the account are two screens, and only one of them is new.
 *
 * They were one page mixing what a colleague sees with how Polaris reaches you.
 * Splitting them could have been done either way round, and the way round
 * matters: several places in the product hand somebody a link to "your profile"
 * and every one of them points at /account. Had the profile moved, each of those
 * would have quietly started opening the addresses screen, and the fix would
 * have been a redirect on the account app's own landing path - which this
 * project may not have, because a permanent one is cached forever by every
 * browser that follows it and a temporary one on a landing path is a rule
 * nobody ever gets to delete.
 *
 * So the profile did not move, and this is the test that says so. The paths
 * themselves are checked by app-paths.test.ts; what is pinned here is which
 * screen sits on the address that already existed.
 */

import { describe, expect, it } from "vitest";
import { ACCOUNT_HOME } from "@/lib/app-access";
import { APP_SECTIONS, POLARIS_APPS } from "@/lib/apps";

const account = APP_SECTIONS.account ?? [];

describe("the account rail", () => {
    it("leaves the profile on the address the rest of the product links to", () => {
        expect(account.find((section) => section.href === "/account")?.label).toBe("Profile");
        expect(POLARIS_APPS.find((app) => app.id === "account")?.href).toBe("/account");
        expect(ACCOUNT_HOME).toBe("/account");
    });

    it("gives the plumbing a screen of its own", () => {
        const details = account.find((section) => section.href === "/account/details");
        expect(details?.label).toBe("Account");
        // Somebody looking for where their email address lives types "email",
        // not "account details".
        expect(details?.keywords).toContain("email");
        expect(details?.keywords).toContain("phone");
    });

    it("stops the profile answering for the words that moved next door", () => {
        // Two screens both claiming "email" in search is a coin toss for whoever
        // typed it.
        const profile = account.find((section) => section.href === "/account");
        expect(profile?.keywords).not.toContain("email");
    });
});
