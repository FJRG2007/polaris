import { describe, expect, it } from "vitest";
import { worthChoosing } from "@/app/(app)/chat/device-choice";

const device = (id: string) => ({ id });

describe("worthChoosing", () => {
    it("offers no choice with no device or a single one", () => {
        expect(worthChoosing([])).toBe(false);
        expect(worthChoosing([device("built-in")])).toBe(false);
    });

    it("does not count Chromium's stand-ins for a real device", () => {
        expect(
            worthChoosing([device("default"), device("communications"), device("built-in")])
        ).toBe(false);
    });

    it("offers a choice once a second real device appears", () => {
        expect(worthChoosing([device("default"), device("built-in"), device("headset")])).toBe(
            true
        );
    });

    it("takes the stand-ins as they come when they are all there is", () => {
        expect(worthChoosing([device("default")])).toBe(false);
        expect(worthChoosing([device("default"), device("communications")])).toBe(true);
    });
});
