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

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const getDriverForConnection = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        storageConnection: { findFirst, findUnique: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
        organization: { findUnique: vi.fn() }
    }
}));
vi.mock("@/lib/setting-store", () => ({
    getSetting: vi.fn(async () => null),
    setSetting: vi.fn()
}));
vi.mock("@/lib/storage-service", () => ({
    PERSONAL_LOCAL_FOLDER: "drive",
    getDriverForConnection
}));

const { discardOrganizationDrive, organizationDriveId, organizationDriveName } = await import(
    "@/lib/organization-drive"
);

const ORG = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
    vi.clearAllMocks();
    findFirst.mockResolvedValue({
        id: ORG,
        name: "Acme files",
        config: JSON.stringify({ kind: "personal", targetId: "local", root: `orgs/${ORG}` })
    });
});

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

describe("taking a company's files with the organization", () => {
    /** A shelf whose root answers in pages, the way a bucket does. */
    function shelf(pages: Array<{ entries: Array<{ path: string }>; nextCursor?: string }>) {
        return {
            list: vi.fn(async () => pages.shift() ?? { entries: [] }),
            delete: vi.fn(async () => undefined),
            dispose: vi.fn(async () => undefined)
        };
    }

    it("empties a root that does not fit in one listing", async () => {
        // The row carrying the organization's id cascades away with it, so
        // nothing afterwards knows a company's whole document store is sitting
        // on the disk - and a bucket answers a thousand keys at a time, so
        // stopping at the first page leaves most of it there.
        const driver = shelf([
            { entries: [{ path: "contracts" }], nextCursor: "page-2" },
            { entries: [{ path: "policies" }] }
        ]);
        getDriverForConnection.mockResolvedValue(driver);

        expect(await discardOrganizationDrive(ORG)).toBeNull();
        expect(driver.delete.mock.calls.map((call) => call[0])).toEqual(["contracts", "policies"]);
        expect(driver.list.mock.calls[1][1]).toEqual({ cursor: "page-2" });
    });

    it("names what it could not take rather than blocking the deletion", async () => {
        // A NAS that is away must not be able to refuse a deletion somebody
        // confirmed. Nothing retries, so the audit entry is the only place an
        // operator ever learns there is a folder left to sweep up.
        getDriverForConnection.mockRejectedValue(new Error("The disk is away"));

        const left = await discardOrganizationDrive(ORG);

        expect(left).toContain(`orgs/${ORG}`);
        expect(left).toContain("The disk is away");
    });

    it("is nothing to do for an organization that never had one", async () => {
        findFirst.mockResolvedValue(null);
        expect(await discardOrganizationDrive(ORG)).toBeNull();
        expect(getDriverForConnection).not.toHaveBeenCalled();
    });

    it("is done before the row saying where the files are goes", () => {
        // Afterwards there is nothing left to read the path from. Asserted
        // against the source because the deletion and the discard are in
        // different modules, and the next person to touch either will not have
        // read this file.
        const source = readFileSync("src/lib/orgs/org-service.ts", "utf8");
        const deletes = source.indexOf("prisma.organization.delete(");
        const drops = source.lastIndexOf("discardOrganizationDrive(", deletes);
        expect(deletes).toBeGreaterThan(-1);
        expect(drops).toBeGreaterThan(-1);
    });
});
