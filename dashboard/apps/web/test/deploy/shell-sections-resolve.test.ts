/**
 * Every tab in a project's rail leads somewhere.
 *
 * The Settings tab pointed at `/admin/settings` for as long as it existed. Those
 * paths are appended to the project's own, so what it actually produced was
 * `/apps/deploy/<id>/admin/settings` - a route that has never existed, on a tab
 * nobody clicks until the day they need it. Nothing failed, nothing was logged,
 * and the only symptom was a 404 on the one screen a project is configured from.
 *
 * A link is not the kind of thing a type checker can follow, so this walks the
 * routes on disk instead. It is the cheapest guard that would have caught it,
 * and it catches the next one: a tab added before its page, a page moved or
 * renamed out from under its tab.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SECTIONS } from "@/app/(app)/apps/deploy/project-sections";

/** The project's own route folder, which every section path hangs off. */
const PROJECT_ROUTE = join(process.cwd(), "src/app/(app)/apps/deploy/[projectId]");

/**
 * Whether a path under the project resolves to a page.
 *
 * Two shapes count. A folder holding `page.tsx` is the ordinary one; a folder
 * holding an optional catch-all that holds `page.tsx` is how Settings serves its
 * ten sections from one file, and `/settings` with no section is a real address
 * on it.
 */
function resolves(path: string): boolean {
    const folder = join(PROJECT_ROUTE, path);
    if (existsSync(join(folder, "page.tsx"))) return true;
    return existsSync(join(folder, "[[...section]]", "page.tsx"));
}

describe("the project rail", () => {
    it("has a page behind every tab", () => {
        const broken = SECTIONS.filter((section) => !resolves(section.path)).map(
            (section) => `${section.label} -> ${section.path || "(project root)"}`
        );
        expect(broken).toEqual([]);
    });

    it("keeps those paths relative to the project", () => {
        for (const section of SECTIONS) {
            // The bug in one assertion. A path that reads like a route of its own
            // - `/admin/settings`, `/apps/firewall` - is not one here: it is
            // appended, so it becomes a segment under the project and lands
            // nowhere. Anything with a second slash in it is that mistake.
            expect(section.path.split("/").filter(Boolean).length, section.label).toBeLessThan(2);
        }
    });

    it("starts each one with a slash, or is the project root", () => {
        for (const section of SECTIONS) {
            if (section.path === "") continue;
            expect(section.path.startsWith("/"), section.label).toBe(true);
        }
    });
});
