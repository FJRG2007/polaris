/**
 * Media auto-download (ledger row 5) and the organization exemptions of the
 * spam restriction (ledger row 24): pure rules only.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/setting-store", () => ({ getSetting: vi.fn(async () => null), setSetting: vi.fn() }));
vi.mock("@/lib/privacy-service", () => ({ colleaguesAmong: vi.fn(async () => new Set()) }));

const { resolveAutoDownload } = await import("@/lib/chat/auto-download");
const { exemptFromRestriction, restrictionHoursLeft } = await import("@/lib/chat/spam-restriction");

describe("auto-download choice", () => {
    it("uses the reader's own choice when it is a known one", () => {
        expect(resolveAutoDownload("none", "all")).toBe("none");
        expect(resolveAutoDownload("contacts", "none")).toBe("contacts");
    });

    it("falls back to the instance's for a reader who never chose or holds garbage", () => {
        expect(resolveAutoDownload(null, "contacts")).toBe("contacts");
        expect(resolveAutoDownload(undefined, "all")).toBe("all");
        expect(resolveAutoDownload("bogus", "none")).toBe("none");
    });
});

describe("spam restriction exemptions", () => {
    const standing = (over: Partial<Parameters<typeof exemptFromRestriction>[1] & object> = {}) => ({
        actorAdmin: false,
        actorMember: true,
        members: new Set(["a", "b"]),
        ...over
    });

    it("never exempts outside an organization", () => {
        expect(exemptFromRestriction({ orgId: null, targets: ["a"] }, standing({ actorAdmin: true }))).toBe(false);
        expect(exemptFromRestriction({ orgId: "o", targets: ["a"] }, null)).toBe(false);
    });

    it("exempts the organization's owner or administrators", () => {
        expect(exemptFromRestriction({ orgId: "o", targets: ["stranger"] }, standing({ actorAdmin: true }))).toBe(true);
    });

    it("exempts a member adding only fellow members", () => {
        expect(exemptFromRestriction({ orgId: "o", targets: ["a", "b"] }, standing())).toBe(true);
    });

    it("refuses with one outsider among the targets, or a non-member actor, or nobody named", () => {
        expect(exemptFromRestriction({ orgId: "o", targets: ["a", "x"] }, standing())).toBe(false);
        expect(exemptFromRestriction({ orgId: "o", targets: ["a"] }, standing({ actorMember: false }))).toBe(false);
        expect(exemptFromRestriction({ orgId: "o", targets: [] }, standing())).toBe(false);
    });

    it("rounds the time left up to whole hours, at least one", () => {
        const now = Date.UTC(2026, 10, 22, 12);
        expect(restrictionHoursLeft({ until: new Date(now + 90 * 60 * 1000), people: 5 }, now)).toBe(2);
        expect(restrictionHoursLeft({ until: new Date(now + 1000), people: 5 }, now)).toBe(1);
    });
});
