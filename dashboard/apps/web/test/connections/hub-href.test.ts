/**
 * The link an app follows to Connected accounts: the service it is for and its
 * own screen to come back to, spelled the way the hub and the link flow read them.
 */

import { describe, expect, it } from "vitest";
import { connectionsHref } from "../../src/lib/connections/hub-href";
import { strictSafeRedirect } from "../../src/lib/safe-redirect";

describe("linking to Connected accounts", () => {
    it("is the bare list when it has nothing to carry", () => {
        expect(connectionsHref()).toBe("/account/connections");
    });

    it("names the service and the screen to come back to", () => {
        expect(connectionsHref("github", "/apps/servers/host-1")).toBe(
            "/account/connections?provider=github&return=%2Fapps%2Fservers%2Fhost-1"
        );
        expect(connectionsHref(null, "/account/notifications")).toBe(
            "/account/connections?return=%2Faccount%2Fnotifications"
        );
    });
});

describe("an optional same-origin target", () => {
    it("keeps a path here and refuses one that leaves", () => {
        expect(strictSafeRedirect("/")).toBe("/");
        expect(strictSafeRedirect("/apps/deploy?x=1")).toBe("/apps/deploy?x=1");
        expect(strictSafeRedirect(null)).toBeNull();
        expect(strictSafeRedirect("")).toBeNull();
        expect(strictSafeRedirect("https://evil.example")).toBeNull();
        expect(strictSafeRedirect("//evil.example")).toBeNull();
        expect(strictSafeRedirect("/\\evil.example")).toBeNull();
    });
});
