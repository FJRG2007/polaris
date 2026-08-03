/**
 * Which section the left rail marks as where you are.
 *
 * The rule being protected: a section that another section sits underneath must
 * only light up on its own path. It used to be a hand-kept list of such roots,
 * and "/tasks" was missing from it - so My work stayed highlighted on every
 * screen in Tasks. The sweep at the bottom is what stops the next root added to
 * APP_SECTIONS from repeating it.
 */

import { describe, expect, it } from "vitest";
import { APP_SECTIONS, isSectionActive } from "@/lib/apps";

describe("isSectionActive", () => {
    it("keeps a section lit across its own sub-routes", () => {
        const drive = APP_SECTIONS.drive ?? [];
        expect(isSectionActive("/drive/recent", "/drive/recent", drive)).toBe(true);
        expect(isSectionActive("/drive/recent/2026", "/drive/recent", drive)).toBe(true);
    });

    it("releases a root once one of its own sub-routes is open", () => {
        const tasks = APP_SECTIONS.tasks ?? [];
        expect(isSectionActive("/tasks", "/tasks", tasks)).toBe(true);
        expect(isSectionActive("/tasks/everything", "/tasks", tasks)).toBe(false);
        expect(isSectionActive("/tasks/everything", "/tasks/everything", tasks)).toBe(true);
        // A space is nobody's section, so nothing in the rail claims it.
        expect(tasks.some((section) => isSectionActive("/tasks/s/abc", section.href, tasks))).toBe(false);
    });

    it("does not treat a shared name prefix as nesting", () => {
        const sections = [{ label: "Tasks", href: "/tasks", icon: null as never }];
        expect(isSectionActive("/tasks-archive", "/tasks", sections)).toBe(false);
    });

    it("leaves at most one section of an app lit on any of its own paths", () => {
        for (const [app, sections] of Object.entries(APP_SECTIONS)) {
            for (const section of sections) {
                const lit = sections.filter((entry) => isSectionActive(section.href, entry.href, sections));
                expect(lit.map((entry) => entry.href), `${app} at ${section.href}`).toEqual([section.href]);
            }
        }
    });
});
