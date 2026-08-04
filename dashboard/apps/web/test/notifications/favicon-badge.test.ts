import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { badgeLabel } from "@/lib/notification-badge";
import { MARK_BACKGROUND, MARK_CORNER, MARK_SIZE, MARK_STAR } from "@/lib/favicon";

describe("badgeLabel", () => {
    it("says nothing when everything is read", () => {
        expect(badgeLabel(0)).toBeNull();
    });

    it("counts up to nine", () => {
        expect(badgeLabel(1)).toBe("1");
        expect(badgeLabel(9)).toBe("9");
    });

    it("stops at nine, which is all a 16px tab icon can carry", () => {
        expect(badgeLabel(10)).toBe("9+");
        expect(badgeLabel(4213)).toBe("9+");
    });

    it("ignores a count that is not one", () => {
        expect(badgeLabel(-3)).toBeNull();
        expect(badgeLabel(Number.NaN)).toBeNull();
    });
});

describe("the served icon", () => {
    // The badged icon is drawn from the constants rather than from this file, so
    // a change to one and not the other would make the tab flip between two
    // different marks as alerts arrive.
    const svg = readFileSync(fileURLToPath(new URL("../../src/app/icon.svg", import.meta.url)), "utf8");

    it("is the mark the badge is drawn on", () => {
        expect(svg).toContain(`viewBox="0 0 ${MARK_SIZE} ${MARK_SIZE}"`);
        expect(svg).toContain(`rx="${MARK_CORNER}"`);
        expect(svg).toContain(`fill="${MARK_BACKGROUND}"`);
        expect(svg).toContain(`d="${MARK_STAR}"`);
    });
});
