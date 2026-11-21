/**
 * The Privacy Checkup's recommendations (ledger row 12) must be something each
 * row can actually show and save, for every field there is.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";

describe("the checkup's recommendations", () => {
    it("names every privacy field", () => {
        expect(Object.keys(core.RECOMMENDED_PRIVACY).sort()).toEqual([...core.PRIVACY_FIELDS].sort());
    });

    it("recommends only an audience the field offers and that names nobody in particular", () => {
        for (const field of core.PRIVACY_FIELDS) {
            const audience = core.RECOMMENDED_PRIVACY[field];
            expect(core.defaultAudiencesFor(field)).toContain(audience);
            expect(core.audienceNeedsList(audience)).toBe(false);
        }
    });

    it("saves through the same schema the privacy page uses", () => {
        const settings = Object.fromEntries(
            core.PRIVACY_FIELDS.map((field) => [
                field,
                { audience: core.RECOMMENDED_PRIVACY[field], listId: null, people: [] }
            ])
        );
        expect(core.privacySettingsSchema.safeParse(settings).success).toBe(true);
    });
});
