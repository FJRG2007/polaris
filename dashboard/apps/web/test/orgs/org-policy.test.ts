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
    ALL_ORG_PERMISSIONS,
    hasOrgPermission,
    ORG_PERMISSION_META,
    ORG_PERMISSIONS,
    ORG_SYSTEM_ROLES,
    ORGANIZATION_POLICY_DEFAULTS,
    organizationPolicySchema,
    orgRoleSchema,
    orgRoleSlugField,
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
    it("answers the wildcard to everything, including permissions added later", () => {
        for (const permission of ORG_PERMISSIONS) {
            expect(hasOrgPermission([ALL_ORG_PERMISSIONS], permission)).toBe(true);
        }
        expect(hasOrgPermission(["org.read"], "org.read")).toBe(true);
        expect(hasOrgPermission(["org.read"], "people.manage")).toBe(false);
        expect(hasOrgPermission([], "org.read")).toBe(false);
    });

    it("seeds an admin that is unrestricted and a member that only looks", () => {
        expect(ORG_SYSTEM_ROLES.admin?.permissions).toEqual([ALL_ORG_PERMISSIONS]);
        expect(ORG_SYSTEM_ROLES.member?.permissions).toEqual(["org.read"]);
    });

    it("describes every permission, so none can go missing from the editor", () => {
        for (const permission of ORG_PERMISSIONS) {
            expect(ORG_PERMISSION_META[permission]?.label).toBeTruthy();
            expect(ORG_PERMISSION_META[permission]?.area).toBeTruthy();
        }
    });

    it("refuses a written role that grants the wildcard", () => {
        // Only the seeded admin holds it. A role anybody writes must not quietly
        // inherit whatever a later version of Polaris adds.
        expect(orgRoleSchema.safeParse({ name: "Ops", slug: "ops", permissions: ["*"] }).success).toBe(false);
        expect(orgRoleSchema.safeParse({ name: "Ops", slug: "ops", permissions: ["teams.manage"] }).success).toBe(true);
    });

    it("keeps role handles short and typeable", () => {
        expect(orgRoleSlugField.safeParse("qa").success).toBe(true);
        expect(orgRoleSlugField.safeParse("Q").success).toBe(false);
        expect(orgRoleSlugField.safeParse("head of ops").success).toBe(false);
        expect(orgRoleSlugField.safeParse("-ops").success).toBe(false);
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
