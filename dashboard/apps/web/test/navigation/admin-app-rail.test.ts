/**
 * An app's administrator screens under Polaris apps have a rail of their own:
 * its details and its settings, and Chat's settings screen by screen - never
 * the Platform rail (Updates, Domains, Remote access...) they used to borrow.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adminAppIdForPath, isSectionActive, resolveSubapp } from "@/lib/apps";

const labels = (locale: string) =>
    (
        JSON.parse(
            readFileSync(join(__dirname, "../../messages", locale, "nav.json"), "utf8")
        ) as { labels: Record<string, string> }
    ).labels;

describe("an app's rail under Polaris apps", () => {
    it("is the app's, not Platform's, on its settings and every screen under it", () => {
        for (const path of [
            "/admin/apps/chat/settings",
            "/admin/apps/chat/settings/calls",
            "/admin/apps/vpn",
            "/admin/apps/vpn/settings"
        ]) {
            const rail = resolveSubapp(path);
            expect(rail?.id.startsWith("admin-app:"), path).toBe(true);
            expect(rail?.sections.map((section) => section.href)).not.toContain("/admin/domains");
            expect(rail?.parent).toEqual({ label: "Polaris apps", href: "/admin/apps" });
        }
    });

    it("leaves the list of apps itself on the Platform rail", () => {
        expect(adminAppIdForPath("/admin/apps")).toBeNull();
        expect(resolveSubapp("/admin/apps")?.id).toBe("admin-platform");
    });

    it("lists Chat's settings screen by screen, each active on its own page", () => {
        const rail = resolveSubapp("/admin/apps/chat/settings/links");
        const hrefs = rail?.sections.map((section) => section.href) ?? [];
        expect(rail?.label).toBe("Chat");
        expect(hrefs).toEqual([
            "/admin/apps/chat/settings",
            "/admin/apps/chat/settings/files",
            "/admin/apps/chat/settings/organizations",
            "/admin/apps/chat/settings/links",
            "/admin/apps/chat/settings/calls"
        ]);
        const sections = rail?.sections ?? [];
        const active = hrefs.filter((href) =>
            isSectionActive("/admin/apps/chat/settings/links", href, sections)
        );
        expect(active).toEqual(["/admin/apps/chat/settings/links"]);
    });

    it("offers Details and Settings for an installable app", () => {
        const hrefs = resolveSubapp("/admin/apps/vpn/settings")?.sections.map((s) => s.href);
        expect(hrefs).toEqual(["/admin/apps/vpn", "/admin/apps/vpn/settings"]);
    });

    it("has every label translated", () => {
        const labelsUsed = [
            ...(resolveSubapp("/admin/apps/chat/settings")?.sections ?? []),
            ...(resolveSubapp("/admin/apps/vpn")?.sections ?? [])
        ].map((section) => section.label);
        for (const locale of ["en-US", "es-ES"]) {
            const table = labels(locale);
            for (const label of [...labelsUsed, "Polaris apps"]) {
                expect(table[label], `${locale}: ${label}`).toBeTruthy();
            }
        }
    });
});
