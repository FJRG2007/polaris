/**
 * A screen that exists only once its marketplace app is installed.
 *
 * Mail server's screen is what is checked here. What is asserted: the rail, the
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

const MAIL = "/mail-server";
const ALL_APPS = POLARIS_APPS.map((app) => app.id).filter((id) => id !== "mail-server");
const mailSection = APP_SECTIONS["mail-server"]?.find((section) => section.href === MAIL) as AppSection;

describe("whether a section is offered", () => {
    it("leaves an app nobody installed out, for an administrator too", () => {
        expect(sectionOffered(mailSection, { isAdmin: true, held: [], installed: [] })).toBe(false);
        expect(sectionOffered(mailSection, { isAdmin: true, held: [], installed: ["mail-server"] })).toBe(true);
    });

    it("still asks the permission once it is installed", () => {
        const installed = ["mail-server"];
        expect(sectionOffered(mailSection, { isAdmin: false, held: [], installed })).toBe(false);
        expect(sectionOffered(mailSection, { isAdmin: false, held: ["mailserver.manage"], installed })).toBe(true);
    });

    it("changes nothing for a section that needs no app", () => {
        const deploy = APP_SECTIONS.apps?.find((section) => section.href === "/apps/deploy") as AppSection;
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
            await installedSectionApps({ isAdmin: true, can: async () => true, isInstalled: async () => true })
        ).toContain("mail-server");
    });

    it("treats every one as present for a role preview, which has no probe", async () => {
        expect(await installedSectionApps({ isAdmin: false, can: async () => true })).toContain("mail-server");
    });
});

describe("the rail", () => {
    it("no longer draws Mail server in the Apps rail", () => {
        const html = renderToStaticMarkup(<AppSidebar appIds={ALL_APPS} isAdmin installed={["mail-server"]} />);
        expect(html).not.toContain(`href="${MAIL}"`);
        expect(html).toContain('href="/apps/deploy"');
    });
});

describe("the search", () => {
    // What reachableApps hands search: the app itself is out for anybody it
    // would turn away, so this mirrors its permission and its install.
    const reachable = (gate: { held: string[]; installed: string[] } | undefined, isAdmin: boolean) =>
        !gate ||
        (gate.installed.includes("mail-server") && (isAdmin || gate.held.includes("mailserver.manage")));
    const hrefs = (gate?: { held: string[]; installed: string[] }, isAdmin = true) =>
        navigationEntries(
            isAdmin,
            reachable(gate, isAdmin) ? [...ALL_APPS, "mail-server"] : ALL_APPS,
            gate
        ).map((entry) => entry.href);

    it("finds Mail server only once it is installed", () => {
        expect(hrefs({ held: [], installed: [] })).not.toContain(MAIL);
        expect(hrefs({ held: [], installed: ["mail-server"] })).toContain(MAIL);
    });

    it("does not find it for somebody who cannot manage mail servers", () => {
        expect(hrefs({ held: [], installed: ["mail-server"] }, false)).not.toContain(MAIL);
        expect(hrefs({ held: ["mailserver.manage"], installed: ["mail-server"] }, false)).toContain(MAIL);
    });

    it("lists every section when nothing narrows it", () => {
        expect(hrefs()).toContain(MAIL);
    });
});
