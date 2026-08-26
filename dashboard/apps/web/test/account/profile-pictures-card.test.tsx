// @vitest-environment jsdom

/**
 * The two pictures on your profile, edited where you can see them.
 *
 * They were two cards, each with a little preview of its own, and the one
 * question worth answering was in neither of them: whether the face and the band
 * look right together - whether the face lands on a busy part of the picture,
 * whether the colours fight. So the card is the profile itself, at the same
 * proportions, and each picture carries its own handle.
 *
 * What is asserted is that both pictures are actually drawn here, that each has
 * a handle of its own offering everything that can be done to it, and that the
 * one thing a handle cannot do to a picture that is not there is not offered.
 * The failure this replaces is a card that previews one thing and edits another.
 */

import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfilePicturesCard } from "@/app/(app)/account/avatar-card";
import { cleanup, render, screen, within } from "@testing-library/react";

// Where somebody is has nothing to do with their photo, and the store behind it
// wants a provider this card is never drawn inside.
vi.mock("@/components/presence-store", () => ({ usePresence: () => null }));

const PERSON = { userId: "018f2b7a-0000-7000-8000-00000000000a", name: "Ada Lovelace" };

/** What one handle offers, once it has been opened. */
async function optionsOf(label: string): Promise<string[]> {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: label }));
    const menu = await screen.findByRole("menu");
    return within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent?.trim() ?? "");
}

afterEach(cleanup);

describe("the profile pictures card", () => {
    it("draws the band and the face together, as the profile does", () => {
        const { container } = render(<ProfilePicturesCard {...PERSON} hasPhoto hasBanner />);
        expect(container.querySelector(`img[src='/api/banner/${PERSON.userId}']`)).not.toBeNull();
        expect(container.querySelector(`img[src='/api/avatar/${PERSON.userId}']`)).not.toBeNull();
        expect(screen.getByText("Ada Lovelace")).toBeDefined();
    });

    it("puts a handle on each picture rather than a row of buttons under both", () => {
        render(<ProfilePicturesCard {...PERSON} hasPhoto hasBanner />);
        expect(screen.getByRole("button", { name: "Edit photo" })).toBeDefined();
        expect(screen.getByRole("button", { name: "Edit banner" })).toBeDefined();
    });

    it("offers to move, swap or take away a picture that is there", async () => {
        render(<ProfilePicturesCard {...PERSON} hasPhoto hasBanner />);
        expect(await optionsOf("Edit photo")).toEqual(["Reframe", "Replace", "Remove"]);
    });

    it("offers only to upload the one that is not there", async () => {
        render(<ProfilePicturesCard {...PERSON} hasPhoto={false} hasBanner={false} />);
        expect(await optionsOf("Edit banner")).toEqual(["Upload banner"]);
    });

    it("reframes the picture that is already there, without asking for a file", async () => {
        // The bytes it goes and gets are the picture Polaris is serving: what was
        // cut off at upload is gone, so reframing pans and zooms inside what was
        // kept rather than pretending to have the original back.
        const asked: string[] = [];
        vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
            asked.push(String(input));
            return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
        });
        // jsdom has neither object URLs nor a ResizeObserver, and the cropper
        // wants both the moment it is handed a file.
        vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
        vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));

        render(<ProfilePicturesCard {...PERSON} hasPhoto hasBanner />);
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Edit photo" }));
        await user.click(await screen.findByRole("menuitem", { name: "Reframe" }));

        expect(await screen.findByText("Frame the picture")).toBeDefined();
        expect(asked).toEqual([`/api/avatar/${PERSON.userId}`]);
        vi.unstubAllGlobals();
    });
});
