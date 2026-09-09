import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL_GROUPS } from "@/lib/tools/catalog";

/**
 * The list and the routes, kept honest about each other.
 *
 * A card on the front page is a link somebody presses, so a group that is not
 * marked `soon` has to have a screen behind it - otherwise the app advertises a
 * tool and answers a 404, which is worse than saying it is coming.
 */
describe("the tools catalogue", () => {
    const routeOf = (href: string): string =>
        fileURLToPath(new URL(`../../src/app/(app)${href}/page.tsx`, import.meta.url));

    it("only links to screens that exist", () => {
        const broken = TOOL_GROUPS.filter((group) => !group.soon && !existsSync(routeOf(group.href)));
        expect(broken.map((group) => group.href)).toEqual([]);
    });

    it("does not mark a built screen as coming later", () => {
        const built = TOOL_GROUPS.filter((group) => group.soon && existsSync(routeOf(group.href)));
        expect(built.map((group) => group.href)).toEqual([]);
    });
});
