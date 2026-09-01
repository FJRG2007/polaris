// @vitest-environment jsdom

/**
 * When the letters under a face stop being drawn.
 *
 * Initials are the base rather than the fallback here: they render immediately
 * and the picture is laid over them, so a list of people never flashes empty
 * circles. That works for a photograph, which is opaque edge to edge.
 *
 * It did not work for a logo. An organization's mark is very often a PNG with a
 * transparent background - that is what a brand kit hands you - and laying it
 * over the tinted tile left the initials reading straight through it: "DY"
 * printed across the mark, on the switcher, in every roster, on the
 * organization's own page.
 *
 * So the letters go once a real picture has actually loaded. The two states that
 * must not change are what makes this worth a test: before the picture arrives
 * the initials are still there, and the blank pixel served for an account with no
 * picture at all is not a picture - it leaves them exactly where they were.
 */

import { Avatar, OrgAvatar } from "@/components/avatar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

// Where somebody is has nothing to do with their face, and the store behind it
// wants a provider none of these are drawn inside.
vi.mock("@/components/presence-store", () => ({ usePresence: () => null }));
vi.mock("@/components/photo-access", () => ({ usePhotoOpenable: () => false }));

const PERSON = { id: "018f2b7a-0000-7000-8000-00000000000a", name: "Ada Lovelace" };
const ORG = { id: "018f2b7a-0000-7000-8000-00000000000b", name: "Dyson Yards" };

/** The face's own box, which is the element the letters are written in. */
function tile(name: string): HTMLElement {
    return screen.getByTitle(name);
}

/** Say a picture arrived, and how wide it turned out to be. One pixel is the
 *  blank the picture routes answer with when there is nothing to serve. */
function pictureArrives(width: number): void {
    const image = document.querySelector("img");
    if (!image) throw new Error("the face drew no picture to load");
    Object.defineProperty(image, "naturalWidth", { value: width, configurable: true });
    act(() => {
        image.dispatchEvent(new Event("load"));
    });
}

/** Say the picture could not be fetched at all. */
function pictureFails(): void {
    const image = document.querySelector("img");
    act(() => {
        image?.dispatchEvent(new Event("error"));
    });
}

afterEach(cleanup);

describe("a face with a picture on the way", () => {
    it("draws the initials until one arrives", () => {
        render(<Avatar person={PERSON} size={48} />);
        expect(tile(PERSON.name).textContent).toBe("AL");
    });

    it("drops them once a real one has loaded", () => {
        render(<Avatar person={PERSON} size={48} />);
        pictureArrives(256);
        expect(tile(PERSON.name).textContent).toBe("");
    });

    it("keeps them when the answer was the blank pixel", () => {
        render(<Avatar person={PERSON} size={48} />);
        pictureArrives(1);
        expect(tile(PERSON.name).textContent).toBe("AL");
    });

    it("puts them back when the picture fails to load", () => {
        render(<Avatar person={PERSON} size={48} />);
        pictureArrives(256);
        pictureFails();
        expect(tile(PERSON.name).textContent).toBe("AL");
    });
});

describe("an organization's mark", () => {
    it("is not printed on top of its own initials", () => {
        // The case this exists for: a logo with a transparent background, where
        // covering the letters is not the same as removing them.
        render(<OrgAvatar org={ORG} size={64} />);
        expect(tile(ORG.name).textContent).toBe("DY");
        pictureArrives(512);
        expect(tile(ORG.name).textContent).toBe("");
    });
});
