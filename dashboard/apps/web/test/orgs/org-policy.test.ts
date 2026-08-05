/**
 * The instance policy over organizations, and the rule an unset limit follows.
 *
 * A cap of zero means "no cap", because the field it comes from is a number
 * input and an empty one has to mean unlimited rather than none-allowed. Getting
 * that backwards would silently stop everybody creating anything, so it is
 * pinned here.
 */

import { describe, expect, it } from "vitest";
import {
    ORGANIZATION_POLICY_DEFAULTS,
    organizationPolicySchema,
    orgRoleAtLeast,
    orgSlugField,
    suggestSlug,
    withinLimit
} from "@polaris/core";

describe("organization limits", () => {
    it("treats zero as no limit", () => {
        expect(withinLimit(0, 0)).toBe(true);
        expect(withinLimit(0, 10_000)).toBe(true);
    });

    it("allows up to the limit and not past it", () => {
        expect(withinLimit(3, 2)).toBe(true);
        expect(withinLimit(3, 3)).toBe(false);
        expect(withinLimit(3, 4)).toBe(false);
    });

    it("starts an instance uncapped and offering organizations", () => {
        expect(ORGANIZATION_POLICY_DEFAULTS).toEqual({
            creation: "everyone",
            maxPerUser: 0,
            maxMembers: 0,
            maxTeams: 0
        });
    });

    it("fills in what an older stored policy is missing rather than discarding it", () => {
        const parsed = organizationPolicySchema.safeParse({ creation: "admins" });

        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data).toEqual({
            creation: "admins",
            maxPerUser: 0,
            maxMembers: 0,
            maxTeams: 0
        });
    });

    it("refuses a negative cap and a mode it does not have", () => {
        expect(organizationPolicySchema.safeParse({ maxMembers: -1 }).success).toBe(false);
        expect(organizationPolicySchema.safeParse({ creation: "sometimes" }).success).toBe(false);
    });
});

describe("organization roles", () => {
    it("puts the owner above every role", () => {
        expect(orgRoleAtLeast("owner", "admin")).toBe(true);
        expect(orgRoleAtLeast("admin", "admin")).toBe(true);
        expect(orgRoleAtLeast("member", "admin")).toBe(false);
        expect(orgRoleAtLeast("member", "member")).toBe(true);
    });
});

describe("handles", () => {
    it("suggests one from a name people would actually type", () => {
        expect(suggestSlug("Acme Design Co.")).toBe("acme-design-co");
        expect(suggestSlug("  Peña & Sons  ")).toBe("pena-sons");
        expect(suggestSlug("---")).toBe("");
    });

    it("keeps a handle to the alphabet an account username uses", () => {
        expect(orgSlugField.safeParse("acme-design").success).toBe(true);
        expect(orgSlugField.safeParse("ACME").success && orgSlugField.parse("ACME")).toBe("acme");
        expect(orgSlugField.safeParse("ac").success).toBe(false);
        expect(orgSlugField.safeParse("acme design").success).toBe(false);
        expect(orgSlugField.safeParse("-acme").success).toBe(false);
        expect(orgSlugField.safeParse("acme-").success).toBe(false);
    });
});
