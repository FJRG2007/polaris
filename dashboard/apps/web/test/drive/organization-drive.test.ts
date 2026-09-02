/**
 * The company's shelf: where it lives, what it is called, and who gets in.
 *
 * The parts asserted here are the ones that are expensive to get wrong later. A
 * drive's root is written into the row when it is made and never recomputed, so
 * changing the shape of that path silently strands every file already filed
 * under the old one; and who may open it is the difference between a company's
 * legal documents being readable by its people and being readable by anybody who
 * knows a URL.
 */

import { describe, expect, it } from "vitest";
import { organizationDriveId, organizationDriveName } from "@/lib/organization-drive";

describe("an organization's drive", () => {
    it("is found at the organization's own id", () => {
        // The same trick a personal drive uses: no pointer to look up on every
        // request, and provisioning is one upsert - so two people opening Drive
        // at the same moment on a new organization cannot make two drives and
        // split the company's files between them.
        expect(organizationDriveId("018f-org")).toBe("018f-org");
    });

    it("is called after the organization, not after whoever opened it", () => {
        // Somebody in two companies has two shelves in the same sidebar, and
        // "My files" twice would tell them nothing.
        expect(organizationDriveName("Acme")).toBe("Acme files");
    });
});

describe("what the organization Drive permission means", () => {
    it("names changing the files, and says nothing about reading them", async () => {
        const core = await import("@polaris/core");
        expect(core.ORG_PERMISSIONS).toContain("drive.manage");
        // Reading is deliberately not a permission. A permission no existing
        // role holds is a shelf that is empty on every organization that already
        // exists, with nothing on screen saying why - so being on the roster is
        // what opens it, and this is only about writing.
        expect(core.ORG_PERMISSIONS).not.toContain("drive.read");
        expect(core.ORG_PERMISSION_META["drive.manage"].label).toMatch(/change/i);
    });

    it("is covered by the wildcard, so it is not switched off where it matters", async () => {
        // The seeded administrator role carries the wildcard rather than a list,
        // and that is what stops a permission added later arriving switched off
        // for the people who are meant to have it. Asserted because the whole
        // decision to make writing a permission rests on it.
        const core = await import("@polaris/core");
        expect(core.hasOrgPermission([core.ALL_ORG_PERMISSIONS], "drive.manage")).toBe(true);
        // And a role that lists its permissions does not get it for free.
        expect(core.hasOrgPermission(["org.read", "people.manage"], "drive.manage")).toBe(false);
    });
});
