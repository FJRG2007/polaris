// @vitest-environment jsdom

/**
 * A sender with no picture to be had is two letters on a colour, never a hole.
 *
 * The face beside a conversation used to draw its picture and wait: an empty
 * circle for as long as the server spent looking for a mark, and for good when
 * the sender was a colleague with no photo - their picture route answers with a
 * transparent pixel, which loads fine and shows nothing. It is now the same face
 * every account in Polaris has, so the initials are there from the first frame
 * and only a real picture replaces them.
 */

import { tintFor } from "@polaris/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { SenderFace, senderLabel } from "@/app/(app)/mail/sender-face";

vi.mock("@/components/presence-store", () => ({ usePresence: () => null }));
vi.mock("@/components/photo-access", () => ({ usePhotoOpenable: () => false }));

afterEach(cleanup);

/** The face's own box, which is where the letters are written. */
function face(container: HTMLElement): HTMLElement {
    const found = container.querySelector<HTMLElement>("[data-avatar]");
    if (!found) throw new Error("no face drawn");
    return found;
}

function pictureArrives(container: HTMLElement, width: number): void {
    const image = container.querySelector("img");
    if (!image) throw new Error("the face asked for no picture");
    Object.defineProperty(image, "naturalWidth", { value: width, configurable: true });
    act(() => {
        image.dispatchEvent(new Event("load"));
    });
}

function pictureFails(container: HTMLElement): void {
    const image = container.querySelector("img");
    act(() => {
        image?.dispatchEvent(new Event("error"));
    });
}

describe("a sender's face", () => {
    it("draws initials before any picture has arrived", () => {
        const { container } = render(<SenderFace name="Ana Garcia" address="ana@example.test" />);
        expect(face(container).textContent).toBe("AG");
        // Asked for through Polaris, never from the sender's own site.
        expect(container.querySelector("img")?.getAttribute("src")).toBe(
            "/api/mail/face/ana%40example.test"
        );
    });

    it("keeps them when the answer is the blank pixel", () => {
        const { container } = render(<SenderFace name="Ana Garcia" address="ana@example.test" />);
        pictureArrives(container, 1);
        expect(face(container).textContent).toBe("AG");
    });

    it("keeps them, and drops the picture, when there is no mark at all", () => {
        const { container } = render(<SenderFace name="Ana Garcia" address="ana@example.test" />);
        pictureFails(container);
        expect(face(container).textContent).toBe("AG");
        // Nothing left that a browser would draw as a broken picture.
        expect(container.querySelector("img")).toBeNull();
    });

    it("gives way to a real mark once it has loaded", () => {
        const { container } = render(<SenderFace name="Fixture Shop" address="orders@shop.test" />);
        pictureArrives(container, 64);
        expect(face(container).textContent).toBe("");
    });

    it("is the same colour for the same address on every screen", () => {
        const first = render(<SenderFace name="Ana" address="ana@example.test" />);
        const colour = face(first.container).style.backgroundColor;
        cleanup();
        const second = render(<SenderFace name="Ana García" address="ana@example.test" />);
        expect(face(second.container).style.backgroundColor).toBe(colour);
        expect(colour).not.toBe("");
        // Derived from the address, so two senders who share a display name
        // ("Support") are still told apart.
        expect(tintFor("ana@example.test")).not.toBe(tintFor("support@shop.test"));
    });

    it("takes the same room before and after the picture", () => {
        const { container } = render(
            <SenderFace name="Ana" address="ana@example.test" size={28} />
        );
        const before = `${face(container).style.width}x${face(container).style.height}`;
        pictureArrives(container, 64);
        expect(`${face(container).style.width}x${face(container).style.height}`).toBe(before);
        expect(before).toBe("28pxx28px");
    });

    it("is not read out: the name is beside it", () => {
        const { container } = render(<SenderFace name="Ana" address="ana@example.test" />);
        expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    });
});

describe("the letters a sender is drawn by", () => {
    it("uses the name, then the address before the @, then the address", () => {
        expect(senderLabel("  Ana Garcia ", "ana@example.test")).toBe("Ana Garcia");
        expect(senderLabel("", "noreply@news.test")).toBe("noreply");
        expect(senderLabel("", "@odd")).toBe("@odd");
    });
});
