/**
 * Every integration in the catalogue has a logo of its own.
 *
 * The fallback is a generic block, and a generic block is indistinguishable from
 * a logo that failed to load: a card whose whole job is to be recognised at a
 * glance instead reads as one that is broken. Six of them were drawing it -
 * Criminal IP, Minecraft, Krisp, Tenor, Giphy and the gateway - and nothing said
 * so, because a missing entry in a map is not an error anywhere.
 *
 * This is the check that makes adding an integration without its mark fail here
 * rather than on the screen.
 */

import { describe, expect, it } from "vitest";
import { hasIntegrationLogo } from "@/components/logos";
import { INTEGRATIONS } from "@/lib/integrations/registry";

describe("integration logos", () => {
    it("covers every entry in the catalogue", () => {
        const missing = INTEGRATIONS.filter((entry) => !hasIntegrationLogo(entry.slug)).map((entry) => entry.slug);
        expect(missing).toEqual([]);
    });

    it("does not claim one for something that is not in the catalogue", () => {
        // The map is keyed by slug and nothing checks the spelling, so a typo
        // would otherwise be a logo registered for an integration that does not
        // exist while the real one draws the block.
        expect(hasIntegrationLogo("not-an-integration")).toBe(false);
    });
});
