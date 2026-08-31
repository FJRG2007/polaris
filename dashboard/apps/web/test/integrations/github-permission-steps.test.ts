/**
 * The two steps a GitHub permission actually takes, and telling them apart.
 *
 * This is the bug the tests exist for. `APP_PERMISSIONS` is what Polaris wants;
 * GitHub is handed it once, in the manifest that creates the App, and publishes
 * no way to change it afterwards - not by API, not by any URL that accepts one.
 * Only the App's owner can, by hand, on the App's own settings page.
 *
 * So for an App created before a permission was added to that list:
 *
 *   1. The App does not ask for it.
 *   2. No installation is therefore holding a request for it.
 *   3. The installation's acceptance page has nothing on it.
 *
 * Polaris read step 2 and reported it as step 3, so it told somebody "your
 * account has not granted Deployments", sent them to a page with no Review
 * request on it, and said the same thing again a few minutes later. Forever,
 * with nothing anybody could press to make it either true or quiet.
 *
 * `missingAppPermissions` is the one comparison behind both steps - what an
 * installation was granted against what the App asks, and what the App asks
 * against what Polaris wants - so it is what these pin down.
 */

import { describe, expect, it } from "vitest";
import { APP_PERMISSIONS, missingAppPermissions } from "@/lib/github-service";
import { permissionLabel, permissionList } from "@/lib/integrations/github-permission-copy";

/** An App or installation holding exactly what Polaris asks for. */
const everything = (): Record<string, string> => ({ ...APP_PERMISSIONS });

describe("missingAppPermissions", () => {
    it("finds nothing missing when everything asked for is held", () => {
        expect(missingAppPermissions(everything())).toEqual([]);
    });

    it("names the one that is absent", () => {
        const held = everything();
        delete held.deployments;
        expect(missingAppPermissions(held)).toEqual(["deployments"]);
    });

    it("counts read where write was asked for as missing", () => {
        expect(missingAppPermissions({ ...everything(), deployments: "read" })).toEqual(["deployments"]);
    });

    it("accepts write where only read was asked for", () => {
        // `metadata` is the read-only one. Being given more than was asked for is
        // not a gap, and reporting it as one would send somebody to a page to
        // grant something they already granted twice over.
        expect(APP_PERMISSIONS.metadata).toBe("read");
        expect(missingAppPermissions({ ...everything(), metadata: "write" })).toEqual([]);
    });

    it("treats a row with nothing recorded as complete rather than as wholly missing", () => {
        // Those rows predate the recording. Reading them as "has granted nothing"
        // would put every installation in the deployment on the screen at once.
        expect(missingAppPermissions({})).toEqual([]);
    });

    it("answers the App's own question with the same comparison", () => {
        // The App asking for less than Polaris wants is step 1, and it is the
        // same shape of answer: the set is what the owner has to add by hand.
        const asked = everything();
        delete asked.deployments;
        delete asked.administration;
        expect(missingAppPermissions(asked).sort()).toEqual(["administration", "deployments"]);
    });
});

describe("what the screen says to look for", () => {
    it("uses the label GitHub prints, not the API's key", () => {
        // There is no "pull_requests" anywhere on the page somebody is being sent
        // to, so naming it that way sends them hunting for a row that is not
        // there.
        expect(permissionLabel("pull_requests")).toBe("Pull requests (Read and write)");
        expect(permissionLabel("deployments")).toBe("Deployments (Read and write)");
        expect(permissionLabel("metadata")).toBe("Metadata (Read-only)");
    });

    it("prints an unlabelled permission as GitHub's own key rather than guessing", () => {
        expect(permissionLabel("some_new_scope")).toContain("some_new_scope");
    });

    it("lists them in the order they appear on that page", () => {
        expect(permissionList(["deployments", "administration"])).toBe(
            "Administration (Read and write), Deployments (Read and write)"
        );
    });
});
