// @vitest-environment jsdom
/**
 * A profile band keeps its colour when it is drawn again.
 *
 * Opening the menu on a profile card drew the band again from nothing: the
 * appearance store had no answer for the new mount yet, so the band showed the
 * colour from the face and then the chosen one - a flash. A remount now starts
 * from the colour this page last drew, and a picture that failed is not asked
 * for again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

let stored: { banner: unknown } | null = null;
vi.mock("@/components/profile-style-store", () => ({ useProfileStyle: () => stored }));
vi.mock("@/lib/profile-accent", () => ({
    useAccent: () => ({ hue: 210, saturation: 60, lightness: 50 }),
    accentGradient: () => "linear-gradient(blue, blue)"
}));

import { ProfileBanner, resetProfileBannerMemory } from "@/components/profile-banner";

const PERSON = { id: "00000000-0000-7000-8000-0000000000b1", name: "Ada" };
const PURPLE = { kind: "solid", color: "#7c3aed" } as const;

function band(container: HTMLElement): HTMLElement {
    return container.firstElementChild as HTMLElement;
}

describe("ProfileBanner memory", () => {
    beforeEach(() => resetProfileBannerMemory());
    afterEach(() => {
        cleanup();
        stored = null;
    });

    it("draws the chosen colour on a remount before the store answers again", () => {
        stored = { banner: PURPLE };
        const first = render(<ProfileBanner person={PERSON} />);
        const chosen = band(first.container).style.background;
        expect(chosen).toContain("124, 58, 237");
        first.unmount();

        stored = null;
        const again = render(<ProfileBanner person={PERSON} />);
        expect(band(again.container).style.background).toBe(chosen);
    });

    it("takes a plain answer over the kept colour", () => {
        stored = { banner: PURPLE };
        render(<ProfileBanner person={PERSON} />).unmount();

        stored = { banner: null };
        const again = render(<ProfileBanner person={PERSON} />);
        expect(band(again.container).style.background).toContain("blue");
    });

    it("does not ask again for a picture that failed", () => {
        const first = render(<ProfileBanner person={PERSON} />);
        fireEvent.error(first.container.querySelector("img") as HTMLImageElement);
        expect(first.container.querySelector("img")).toBeNull();
        first.unmount();

        const again = render(<ProfileBanner person={PERSON} />);
        expect(again.container.querySelector("img")).toBeNull();
    });
});
