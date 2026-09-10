/**
 * A screen that exists only once its marketplace app is installed.
 *
 * The Mail server screen is a section of Apps, not an app of its own, so the
 * switcher's install gate never reached it. What is asserted: the rail, the
 * phone drawer, the search and the Overview's shortcut picker all read one
 * answer; that answer is asked of administrators too - they pass every
 * permission and still have no screen for an app nobody installed; and a role
 * preview, which has no install probe, is judged on its grants alone.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { installedSectionApps } from "@/lib/app-access";
import { navigationEntries } from "@/lib/search/entries";
import { APP_SECTIONS, POLARIS_APPS, sectionOffered, type AppSection } from "@/lib/apps";

vi.mock("next/navigation", () => ({ usePathname: () => "/apps/deploy" }));

const { AppSidebar } = await import("@/components/app-sidebar");

const MAIL = "/apps/mail-server";
const ALL_APPS = POLARIS_APPS.map((app) => app.id);
const mailSection = APP_SECTIONS.apps?.find((section) => section.href === MAIL) as AppSection;

describe("whether a section is offered", () => {
    it("leaves an app nobody installed out, for an administrator too", () => {
        expect(sectionOffered(mailSection, { isAdmin: true, held: [], installed: [] })).toBe(false);
        expect(
            sectionOffered(mailSection, { isAdmin: true, held: [], installed: ["mail-server"] })
        ).toBe(true);
    });

    it("still asks the permission once it is installed", () => {
        const installed = ["mail-server"];
        expect(sectionOffered(mailSection, { isAdmin: false, held: [], installed })).toBe(false);
        expect(
            sectionOffered(mailSection, { isAdmin: false, held: ["mailserver.manage"], installed })
        ).toBe(true);
    });

    it("changes nothing for a section that needs no app", () => {
        const deploy = APP_SECTIONS.apps?.find(
            (section) => section.href === "/apps/deploy"
        ) as AppSection;
        expect(sectionOffered(deploy, { isAdmin: false, held: [], installed: [] })).toBe(true);
    });
});

describe("which apps the rails can name", () => {
    it("asks the install probe about every app a section requires", async () => {
        const asked: string[] = [];
        const installed = await installedSectionApps({
            isAdmin: true,
            can: async () => true,
            isInstalled: async (id) => {
                asked.push(id);
                return false;
            }
        });
        expect(asked).toContain("mail-server");
        expect(installed).toEqual([]);
        expect(
            await installedSectionApps({
                isAdmin: true,
                can: async () => true,
                isInstalled: async () => true
            })
        ).toContain("mail-server");
    });

    it("treats every one as present for a role preview, which has no probe", async () => {
        expect(await installedSectionApps({ isAdmin: false, can: async () => true })).toContain(
            "mail-server"
        );
    });
});

describe("the rail", () => {
    it("draws Mail server only once it is installed", () => {
        const without = renderToStaticMarkup(<AppSidebar appIds={ALL_APPS} isAdmin />);
        const withIt = renderToStaticMarkup(
            <AppSidebar appIds={ALL_APPS} isAdmin installed={["mail-server"]} />
        );
        expect(without).not.toContain(`href="${MAIL}"`);
        expect(without).toContain('href="/apps/deploy"');
        expect(withIt).toContain(`href="${MAIL}"`);
    });
});

describe("the search", () => {
    const hrefs = (gate?: { held: string[]; installed: string[] }, isAdmin = true) =>
        navigationEntries(isAdmin, ALL_APPS, gate).map((entry) => entry.href);

    it("finds Mail server only once it is installed", () => {
        expect(hrefs({ held: [], installed: [] })).not.toContain(MAIL);
        expect(hrefs({ held: [], installed: ["mail-server"] })).toContain(MAIL);
    });

    it("does not find it for somebody who cannot manage mail servers", () => {
        expect(hrefs({ held: [], installed: ["mail-server"] }, false)).not.toContain(MAIL);
        expect(hrefs({ held: ["mailserver.manage"], installed: ["mail-server"] }, false)).toContain(
            MAIL
        );
    });

    it("lists every section when nothing narrows it", () => {
        expect(hrefs()).toContain(MAIL);
    });
});
