/**
 * The tab bar is built from the permissions the viewer was found to hold, and the
 * list of permissions to look for is written by hand. So the two can disagree, and
 * when they do the failure is silent and total: a tab gated on a permission nobody
 * ever asks about is a screen that has simply vanished, for everybody, owner
 * included.
 *
 * That is not hypothetical - splitting the console into its own grant did exactly
 * that, and the console disappeared from every server until the list caught up.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GAME_TABS } from "@/app/(app)/apps/installed/[id]/tabs";

describe("what the tab bar is built from", () => {
    it("asks about every permission a tab is gated on", () => {
        const source = readFileSync("src/lib/apps/install-access.ts", "utf8");
        const asked = new Set([...source.matchAll(/"(games\.[a-z-]+)"/g)].map((match) => match[1]));
        for (const tab of GAME_TABS) {
            expect(asked.has(tab.permission), `${tab.slug} is gated on ${tab.permission}`).toBe(true);
        }
    });
});
