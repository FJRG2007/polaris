import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SIDE_PANEL } from "@/app/(app)/apps/deploy/side-panel";

const DEPLOY = join(__dirname, "..", "..", "src", "app", "(app)", "apps", "deploy");

describe("Deploy side panels on a phone", () => {
    const classes = SIDE_PANEL.split(/\s+/);

    it("draws the leading edge only from sm up", () => {
        // Unprefixed, a rounded or bordered start edge shows on a phone too,
        // where the panel is the whole screen.
        expect(classes).not.toContain("rounded-l-xl");
        expect(classes).toContain("sm:rounded-l-xl");
        expect(classes).toContain("max-sm:border-0");
    });

    it("is pinned to the edges, not centred", () => {
        for (const name of ["right-0", "left-auto", "top-0", "h-full", "translate-x-0", "translate-y-0"]) {
            expect(classes).toContain(name);
        }
    });

    it.each(["service-detail.tsx", "volume-detail.tsx", "database-panel.tsx"])(
        "%s takes its placement from the shared string",
        (file) => {
            const source = readFileSync(join(DEPLOY, file), "utf8");
            expect(source).toContain("SIDE_PANEL,");
            expect(source).not.toMatch(/translate-x-0 translate-y-0 flex-col/);
        }
    );
});
