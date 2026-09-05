/**
 * What the appearance panel is allowed to save.
 *
 * The writing door, where reading has its own. Both matter for the same reason:
 * these values are interpolated into a `style` attribute on a page other people
 * read, so the argument that no escaping is needed rests on nothing arriving
 * here that is not either a catalogue id Polaris shipped or six hex digits.
 */

import { describe, expect, it } from "vitest";
import { profileStyleSchema } from "./profile-style.js";

/** Everything turned off, which is what almost every account saves. */
const PLAIN = { banner: null, decoration: null, nameplate: null, effect: null, nameStyle: null };

describe("saving an appearance", () => {
    it("accepts one with nothing in it", () => {
        expect(profileStyleSchema.safeParse(PLAIN).success).toBe(true);
    });

    it("accepts the catalogue's own ids", () => {
        const parsed = profileStyleSchema.safeParse({
            ...PLAIN,
            decoration: "aurora",
            nameplate: "dusk",
            effect: "gilded",
            nameStyle: "tide"
        });
        expect(parsed.success).toBe(true);
    });

    it("refuses an id that is not one of them", () => {
        for (const field of ["decoration", "nameplate", "effect", "nameStyle"]) {
            expect(profileStyleSchema.safeParse({ ...PLAIN, [field]: "made-up" }).success).toBe(false);
        }
    });

    it("refuses anything that is not six hex digits", () => {
        for (const color of [
            "blue",
            "#12345",
            "rgb(1,2,3)",
            "#1b6ac9); background: url(https://example.test/x)",
            "var(--card)"
        ]) {
            expect(profileStyleSchema.safeParse({ ...PLAIN, banner: { kind: "solid", color } }).success).toBe(
                false
            );
        }
    });

    it("stores one spelling of a colour", () => {
        const parsed = profileStyleSchema.parse({ ...PLAIN, banner: { kind: "solid", color: " #AABBCC " } });
        expect(parsed.banner).toEqual({ kind: "solid", color: "#aabbcc" });
    });

    it("wraps an angle instead of refusing the drag that produced it", () => {
        const parsed = profileStyleSchema.parse({
            ...PLAIN,
            banner: { kind: "gradient", angle: 725, from: "#000000", to: "#ffffff" }
        });
        expect(parsed.banner).toMatchObject({ angle: 5 });
    });

    it("refuses a background of a kind it has never heard of", () => {
        expect(
            profileStyleSchema.safeParse({ ...PLAIN, banner: { kind: "image", url: "https://example.test/x" } })
                .success
        ).toBe(false);
    });
});
