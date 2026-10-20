/**
 * The UPS screens moved from Servers into Places: every old address still lands
 * on the new one, before anything is drawn, and the navigation only points at
 * the new place.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { APP_SECTIONS } from "@/lib/apps";
import config from "../../next.config.mjs";
import { describe, expect, it } from "vitest";

describe("the old UPS addresses", () => {
    it("redirect to /places/ups, with the rest of the path carried across", async () => {
        const rules = await config.redirects();
        expect(rules).toContainEqual({
            source: "/apps/servers/ups",
            destination: "/places/ups",
            permanent: false
        });
        expect(rules).toContainEqual({
            source: "/apps/servers/ups/:path*",
            destination: "/places/ups/:path*",
            permanent: false
        });
    });

    it("have no page left to shadow the redirect, and the new ones exist", () => {
        const app = join(process.cwd(), "src/app/(app)");
        expect(existsSync(join(app, "apps/servers/ups/page.tsx"))).toBe(false);
        expect(existsSync(join(app, "places/ups/page.tsx"))).toBe(true);
        expect(existsSync(join(app, "places/ups/[upsId]/page.tsx"))).toBe(true);
    });

    it("are linked from Places, not from Servers", () => {
        const hrefs = Object.values(APP_SECTIONS).flatMap((sections) =>
            sections.map((section) => section.href)
        );
        expect(hrefs).not.toContain("/apps/servers/ups");
        expect(APP_SECTIONS.home?.map((section) => section.href)).toContain("/places/ups");
    });
});
