/**
 * Two tabs of Mail on two shelves: each one's rail, list and composer stay on
 * the shelf that tab drew, whichever shelf the header's shared switch was last
 * moved to in another tab.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "0192f0a0-0000-7000-8000-000000000001";
const LEFT = "0192f0a0-0000-7000-8000-000000000002";

/** The shelf the header's cookie names - whatever another tab switched to. */
let header: string | null = null;
let preference: "shelf" | "all" = "shelf";

vi.mock("@/lib/workspace-scope", () => ({
    scopeOrgIdFor: async () => header,
    recipientShelf: async (_user: string, about: { orgId: string | null }) =>
        about.orgId === ORG ? ORG : null
}));
vi.mock("@/lib/mailbox/prefs", () => ({
    readMailPreferences: async () => ({ mailboxes: preference })
}));

const { mailShelfOfTab, EVERY_SHELF } = await import("@/lib/mailbox/shelf");

beforeEach(() => {
    header = null;
    preference = "shelf";
});

describe("the shelf a tab of Mail is showing", () => {
    it("stays the organization's after another tab switched the header to personal", async () => {
        header = null;
        expect(await mailShelfOfTab("u1", ORG)).toBe(ORG);
    });

    it("stays personal after another tab switched the header to an organization", async () => {
        header = ORG;
        expect(await mailShelfOfTab("u1", "personal")).toBeNull();
    });

    it("keeps every shelf for a tab that drew every mailbox", async () => {
        expect(await mailShelfOfTab("u1", EVERY_SHELF)).toBe(EVERY_SHELF);
    });

    it("is personal for an organization this person is no longer on", async () => {
        header = ORG;
        expect(await mailShelfOfTab("u1", LEFT)).toBeNull();
    });

    it("is the header's when the tab says nothing, or nothing that is a shelf", async () => {
        header = ORG;
        expect(await mailShelfOfTab("u1", undefined)).toBe(ORG);
        expect(await mailShelfOfTab("u1", "")).toBe(ORG);
        expect(await mailShelfOfTab("u1", "'; drop table")).toBe(ORG);
        expect(await mailShelfOfTab("u1", 42)).toBe(ORG);
        preference = "all";
        expect(await mailShelfOfTab("u1", null)).toBe(EVERY_SHELF);
    });
});
