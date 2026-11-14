/**
 * The instance-wide privacy settings live together under Management > Privacy.
 *
 * Public profiles, the follower default and people discovery used to sit at the
 * bottom of the Users directory. They are one screen now, reached from the
 * People & access area beside Users, drawn as headed groups in both languages,
 * and the Users screen no longer carries them.
 */

import { withMessages } from "../setup/i18n";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/(app)/admin/privacy/actions", () => ({
    setDiscoveryPolicyAction: async () => ({}),
    setFollowerDefaultAction: async () => ({}),
    setPublicProfilesAction: async () => ({})
}));

vi.mock("@/lib/session", () => ({ requireAdmin: async () => ({ id: "admin", isAdmin: true }) }));
vi.mock("@/lib/i18n/request", async () => {
    const { webCatalogs } = await import("../../messages");
    const admin = webCatalogs.pick("en-US", ["admin"]).admin as Record<string, unknown>;
    const read = (key: string) =>
        key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], admin);
    return {
        getTranslations: async () => (key: string) => {
            const value = read(key);
            if (typeof value !== "string") throw new Error(`missing admin.${key}`);
            return value;
        }
    };
});

const { APP_SUBAPPS } = await import("@/lib/apps");
const { default: ManagementPage } = await import("@/app/(app)/admin/page");
const { PrivacySections } = await import("@/app/(app)/admin/privacy/privacy-sections");
const { PublicProfilesForm } = await import("@/app/(app)/admin/privacy/public-profiles-form");
const { PeopleDiscoveryForm } = await import("@/app/(app)/admin/privacy/people-discovery-form");

const POLICY = { usernameExact: true, usernamePartial: false, namePartial: false, emailExact: false };

function screen(locale?: "es-ES") {
    return renderToStaticMarkup(
        withMessages(
            <PrivacySections
                profiles={<PublicProfilesForm enabled={false} followerDefault="friends" />}
                discovery={<PeopleDiscoveryForm policy={POLICY} />}
            />,
            locale
        )
    );
}

function area(id: string) {
    const found = APP_SUBAPPS.find((subapp) => subapp.id === id);
    if (!found) throw new Error(`no area ${id}`);
    return found;
}

describe("privacy screen", () => {
    it("draws each group under its own heading", () => {
        const html = screen();
        expect(html).toContain("Profiles");
        expect(html).toContain("Public profiles");
        expect(html).toContain("Followers shown to");
        expect(html).toContain("Finding people");
        expect(html).toContain("Whole username");
        expect(html).toContain("Whole email address");
        expect(html.indexOf("Profiles")).toBeLessThan(html.indexOf("Finding people"));
    });

    it("reads in Spanish", () => {
        const html = screen("es-ES");
        expect(html).toContain("Perfiles públicos");
        expect(html).toContain("Encontrar personas");
        expect(html).not.toContain("privacy.");
    });

    it("is reached from People & access, right after Users", () => {
        const hrefs = area("admin-people").sections.map((section) => section.href);
        expect(hrefs.indexOf("/admin/privacy")).toBe(hrefs.indexOf("/admin/users") + 1);
        expect(area("admin-people").match).toContain("/admin/privacy");
    });

    it("keeps announcements with the other ways of reaching people", () => {
        expect(area("admin-communication").sections.map((section) => section.href)).toContain(
            "/admin/announcements"
        );
        expect(area("admin-people").sections.map((section) => section.href)).not.toContain(
            "/admin/announcements"
        );
    });

    it("is no longer part of the Users screen", () => {
        const loader = readFileSync("src/app/(app)/admin/users/loader.tsx", "utf8");
        expect(loader).not.toMatch(/PeopleDiscoveryForm|PublicProfilesForm/);
    });

    it("has a card on the Management overview, which lists every area screen", async () => {
        const html = renderToStaticMarkup(await ManagementPage());
        expect(html).toContain('href="/admin/privacy"');
        for (const subapp of APP_SUBAPPS.filter((entry) => entry.parentAppId === "admin")) {
            for (const section of subapp.sections) {
                // Setup opens itself; Domains' own screens hang off its card.
                if (section.href === "/admin/setup" || section.href.startsWith("/admin/domains/")) continue;
                expect(html, section.href).toContain(`href="${section.href}"`);
            }
        }
    });
});
