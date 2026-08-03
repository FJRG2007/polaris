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
import { navigationEntries } from "@/lib/search-index";
import { APP_SECTIONS, APP_SUBAPPS, isSectionActive, resolveActiveApp, resolveSubapp } from "@/lib/apps";

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

describe("what search can find", () => {
    const hrefs = navigationEntries(true).map((entry) => entry.href);

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
