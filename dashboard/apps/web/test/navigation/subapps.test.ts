/**
 * Sections big enough to have their own rail.
 *
 * The rule being protected: inside one of these the rail swaps to that subject's
 * screens, and it must always offer a way back to the app it came from. A rail
 * that changes its contents without one is a place people get stuck - which is
 * the whole reason the parent link exists rather than being implied.
 *
 * The sweep at the bottom is what stops the next subject added to APP_SUBAPPS
 * from being reachable only by already being inside it.
 */

import { describe, expect, it } from "vitest";
import { navigationEntries } from "@/lib/search/entries";
import {
    APP_SECTIONS,
    APP_SUBAPPS,
    isSectionActive,
    ORG_BASE,
    orgSlugForPath,
    orgSubapp,
    POLARIS_APPS,
    resolveActiveApp,
    resolveSubapp
} from "@/lib/apps";

describe("resolveSubapp", () => {
    it("claims its own base and everything under it", () => {
        expect(resolveSubapp("/apps/runners")?.id).toBe("runners");
        expect(resolveSubapp("/apps/runners/runs")?.id).toBe("runners");
        expect(resolveSubapp("/apps/runners/repos/anything")?.id).toBe("runners");
    });

    it("leaves the rest of the app alone", () => {
        expect(resolveSubapp("/apps/deploy")).toBeNull();
        expect(resolveSubapp("/apps/servers")).toBeNull();
        // A shared name prefix is not nesting.
        expect(resolveSubapp("/apps/runners-archive")).toBeNull();
    });

    it("still belongs to the app that owns the path, so the switcher does not move", () => {
        expect(resolveActiveApp("/apps/runners/runs").id).toBe("apps");
    });
});

describe("every subject with its own rail", () => {
    it("offers a way back out", () => {
        for (const subapp of APP_SUBAPPS) {
            expect(subapp.parent.href, subapp.id).toBeTruthy();
            expect(resolveSubapp(subapp.parent.href), `${subapp.id} back link`).toBeNull();
        }
    });

    it("has a section on its own base, so the rail marks where you are on arrival", () => {
        for (const subapp of APP_SUBAPPS) {
            expect(
                subapp.sections.map((section) => section.href),
                subapp.id
            ).toContain(subapp.base);
        }
    });

    it("keeps every screen inside the subject it belongs to", () => {
        for (const subapp of APP_SUBAPPS) {
            for (const section of subapp.sections) {
                expect(resolveSubapp(section.href)?.id, section.href).toBe(subapp.id);
            }
        }
    });

    it("leaves at most one of its sections lit on any of its own paths", () => {
        for (const subapp of APP_SUBAPPS) {
            for (const section of subapp.sections) {
                const lit = subapp.sections.filter((entry) =>
                    isSectionActive(section.href, entry.href, subapp.sections)
                );
                expect(lit.map((entry) => entry.href), `${subapp.id} at ${section.href}`).toEqual([section.href]);
            }
        }
    });

    it("is reached from the app's own rail, not only from inside itself", () => {
        for (const subapp of APP_SUBAPPS) {
            const app = resolveActiveApp(subapp.base);
            const sections = APP_SECTIONS[app.id] ?? [];
            expect(
                sections.some((section) => section.href === subapp.base),
                `${subapp.id} is not in the ${app.id} rail`
            ).toBe(true);
        }
    });
});

describe("one organization's own rail", () => {
    const subapp = orgSubapp("acme");

    it("claims the organization and everything under it", () => {
        expect(resolveSubapp("/account/organizations/acme")?.id).toBe("org:acme");
        expect(resolveSubapp("/account/organizations/acme/people")?.id).toBe("org:acme");
        expect(resolveSubapp("/account/organizations/acme/teams/anything")?.id).toBe("org:acme");
    });

    it("leaves the list it came from alone, so the way back out is not itself", () => {
        expect(resolveSubapp(ORG_BASE)).toBeNull();
        expect(resolveSubapp("/account")).toBeNull();
        expect(resolveSubapp("/account/security")).toBeNull();
        expect(resolveSubapp(subapp.parent.href)).toBeNull();
    });

    it("still belongs to the account app, so the switcher does not move", () => {
        expect(resolveActiveApp("/account/organizations/acme/people").id).toBe("account");
    });

    it("reads the handle off the path and nothing else", () => {
        expect(orgSlugForPath("/account/organizations/acme/roles")).toBe("acme");
        expect(orgSlugForPath(ORG_BASE)).toBeNull();
        expect(orgSlugForPath("/account/organizations/")).toBeNull();
        // A handle that arrived percent-encoded has to come back as the handle,
        // or the rail asks the server about a name that does not exist.
        expect(orgSlugForPath("/account/organizations/a%2Db")).toBe("a-b");
    });

    it("has a section on its own base, so the rail marks where you are on arrival", () => {
        expect(subapp.sections.map((section) => section.href)).toContain(subapp.base);
    });

    it("keeps every screen inside the organization it belongs to", () => {
        for (const section of subapp.sections) {
            expect(resolveSubapp(section.href)?.id, section.href).toBe(subapp.id);
        }
    });

    it("leaves at most one of its sections lit on any of its own paths", () => {
        for (const section of subapp.sections) {
            const lit = subapp.sections.filter((entry) => isSectionActive(section.href, entry.href, subapp.sections));
            expect(lit.map((entry) => entry.href), `at ${section.href}`).toEqual([section.href]);
        }
    });

    it("gates exactly the screens that turn a plain member away", () => {
        const gated = subapp.sections.filter((section) => section.permission).map((section) => section.label);
        expect(gated).toEqual(["Roles", "Domains", "Activity", "Settings"]);
    });
});

describe("what search can find", () => {
    const hrefs = navigationEntries(true, POLARIS_APPS.map((app) => app.id)).map((entry) => entry.href);

    it("indexes every screen of a subject, not just its front page", () => {
        for (const subapp of APP_SUBAPPS) {
            for (const section of subapp.sections) {
                expect(hrefs, section.href).toContain(section.href);
            }
        }
    });

    it("lists each of them once", () => {
        expect(hrefs.length).toBe(new Set(hrefs).size);
    });
});
