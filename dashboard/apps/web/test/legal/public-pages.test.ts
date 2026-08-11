/**
 * The three pages that exist outside the login, and the paths they live at.
 *
 * Google's verification is held against those paths months after the form was
 * filled in: a home page that moved, or one that stopped being reachable signed
 * out, fails the re-review and puts the "hasn't verified this app" warning back
 * in front of everybody. So the constants and the files that serve them are
 * checked against each other here, rather than trusted to stay in step.
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PUBLIC_PATHS } from "@/lib/legal/service";
import { privacyDocument, termsDocument } from "@/lib/legal/documents";
import { legalContactSchema, normalizeLegalContact } from "@polaris/core";

describe("public paths", () => {
    it("each one is served by a page outside the authenticated group", () => {
        for (const path of Object.values(PUBLIC_PATHS)) {
            expect(existsSync(new URL(`../../src/app/(public)${path}/page.tsx`, import.meta.url))).toBe(true);
        }
    });

    it("none of them sits at the root, where the dashboard lives", () => {
        for (const path of Object.values(PUBLIC_PATHS)) {
            expect(path.startsWith("/")).toBe(true);
            expect(path).not.toBe("/");
        }
    });
});

describe("legal documents", () => {
    it("say what is done with a connected account, which is what a review desk reads for", () => {
        const privacy = privacyDocument(null);
        const text = privacy.sections.flatMap((section) => section.body).join(" ");
        expect(text).toContain("Google");
        expect(text).toContain("read-only");
        expect(text).toContain("Epic Games");
    });

    it("carry a contact only when the operator set one", () => {
        const withoutContact = privacyDocument(null).sections.map((section) => section.heading);
        expect(withoutContact).not.toContain("Getting in touch");

        const withContact = privacyDocument("ops@example.com");
        const contact = withContact.sections.find((section) => section.heading === "Getting in touch");
        expect(contact?.body.join(" ")).toContain("ops@example.com");

        expect(termsDocument("ops@example.com").sections.map((section) => section.heading)).toContain(
            "Getting in touch"
        );
    });
});

describe("legalContactSchema", () => {
    it("stores one form of an address whichever way it was typed", () => {
        expect(legalContactSchema.parse("  OPS@Example.COM ")).toBe("ops@example.com");
        expect(normalizeLegalContact("  OPS@Example.COM ")).toBe("ops@example.com");
    });

    it("keeps a link's case, because a path can depend on it", () => {
        expect(legalContactSchema.parse(" https://example.com/Contact ")).toBe("https://example.com/Contact");
    });

    it("takes an empty value as publishing no contact", () => {
        expect(legalContactSchema.parse("   ")).toBe("");
    });

    it("refuses what is neither, and a link nobody should be sent to", () => {
        expect(legalContactSchema.safeParse("ops at example dot com").success).toBe(false);
        expect(legalContactSchema.safeParse("http://example.com/contact").success).toBe(false);
        expect(legalContactSchema.safeParse("x".repeat(300)).success).toBe(false);
    });
});
