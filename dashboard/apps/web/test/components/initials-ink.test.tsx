// @vitest-environment jsdom

/**
 * The letters on a face are drawn in an ink that reads on its tint.
 *
 * They were white on every tint, and on the yellows and greens of the palette
 * white is 3.3:1 - under the 4.5:1 a name needs. Each renderer now asks
 * `initialsInk` for its tint, which is white or black by contrast. What is pinned
 * here is that the renderers actually use it, on a tint that needs black and on
 * one that keeps white.
 */

import { Avatar } from "@/components/avatar";
import { ChatAvatar } from "@/components/chat-avatar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { contrastRatio, INITIALS_INK_DARK, initialsInk, INK_LIGHT, tintFor } from "@polaris/core";

vi.mock("@/components/presence-store", () => ({ usePresence: () => null }));
vi.mock("@/components/photo-access", () => ({ usePhotoOpenable: () => false }));

afterEach(cleanup);

/** An id whose tint needs the ink given, found rather than hard-coded, so the
 *  test follows the palette if its hash ever changes. */
function idNeeding(ink: string): string {
    for (let n = 0; n < 10_000; n += 1) {
        const id = `person-${n}`;
        if (initialsInk(tintFor(id)) === ink) return id;
    }
    throw new Error(`no id needs ${ink}`);
}

/** The colour a browser reports for an ink, as jsdom normalizes it. */
const computed = (ink: string) => (ink === INK_LIGHT ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)");

describe("a person's face", () => {
    for (const ink of [INITIALS_INK_DARK, INK_LIGHT]) {
        it(`draws the initials in ${ink} where that is what reads`, () => {
            const id = idNeeding(ink);
            render(<Avatar person={{ id, name: "Ada Lovelace" }} />);
            const face = screen.getByTitle("Ada Lovelace");
            expect(face.textContent).toContain("AL");
            expect(face.style.color).toBe(computed(ink));
            expect(contrastRatio(ink, tintFor(id))).toBeGreaterThanOrEqual(4.5);
        });
    }
});

describe("a conversation's face", () => {
    it("draws the initials at 4.5:1 on every tint it gives a conversation", () => {
        // A conversation has a palette of its own, so this reads back what was
        // drawn - fill and ink - rather than recomputing either.
        const hex = (rgb: string) =>
            `#${(rgb.match(/\d+/g) ?? []).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
        const inks = new Set<string>();
        for (let n = 0; n < 120; n += 1) {
            render(<ChatAvatar kind="channel" id={`channel-${n}`} name={`Room ${n}`} />);
            const face = screen.getByTitle(`Room ${n}`);
            const ratio = contrastRatio(hex(face.style.color), hex(face.style.backgroundColor));
            expect(ratio, `channel-${n}`).toBeGreaterThanOrEqual(4.5);
            inks.add(face.style.color);
            cleanup();
        }
        expect(inks).toEqual(new Set(["rgb(0, 0, 0)", "rgb(255, 255, 255)"]));
    });

    it("reads on a space's own colour too", () => {
        render(<ChatAvatar kind="space" id="s1" name="Lemon" color="#fde047" square />);
        expect(screen.getByTitle("Lemon").style.color).toBe(computed(INITIALS_INK_DARK));
        cleanup();
        render(<ChatAvatar kind="space" id="s1" name="Indigo" color="#4f46e5" square />);
        expect(screen.getByTitle("Indigo").style.color).toBe(computed(INK_LIGHT));
    });
});
