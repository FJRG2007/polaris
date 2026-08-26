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
import { BLANK_AVATAR_ETAG } from "@/lib/avatar-blank";
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

/**
 * What the card reads back off a picture route: whether it answered, the tag
 * that marks the blank pixel, and the bytes.
 *
 * Answered by hand rather than with a `Response`, because how a blob from one
 * realm travels through another one's `Response` is a runtime detail that
 * differs between node versions, and these tests are about the card.
 */
interface PictureReply {
    ok: boolean;
    headers: { get: (name: string) => string | null };
    blob: () => Promise<Blob>;
}

/** A picture a route would serve, under the tag it would carry. */
function pictureReply(etag: string | null = null): PictureReply {
    const picture = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    return {
        ok: true,
        headers: { get: (name) => (name.toLowerCase() === "etag" ? etag : null) },
        blob: async () => picture
    };
}

/**
 * What the cropper needs from a browser and jsdom has none of: object URLs and a
 * ResizeObserver, both wanted the moment it is handed a file.
 *
 * `URL` is replaced with a stand-in rather than patched, so unstubbing actually
 * puts things back - assigning the two functions onto the real constructor
 * leaves them on it for every test that follows, whatever happens to the stub.
 */
function stubTheBrowser(reply: () => PictureReply): string[] {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        asked.push(String(input));
        return reply();
    });
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("URL", class extends URL {
        static createObjectURL = () => "blob:x";
        static revokeObjectURL = () => undefined;
    });
    return asked;
}

afterEach(() => {
    cleanup();
    // In the test body this runs only when everything above it passed, and one
    // failed assertion then leaves fetch stubbed for the rest of the file.
    vi.unstubAllGlobals();
});

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
        const asked = stubTheBrowser(() => pictureReply());

        render(<ProfilePicturesCard {...PERSON} hasPhoto hasBanner />);
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Edit photo" }));
        await user.click(await screen.findByRole("menuitem", { name: "Reframe" }));

        expect(await screen.findByText("Frame the picture")).toBeDefined();
        expect(asked).toEqual([`/api/avatar/${PERSON.userId}`]);
    });

    it("refuses to frame the blank pixel a route answers with when it has no bytes", async () => {
        // The row says there is a photo and the storage behind it did not
        // answer, so the route serves one transparent pixel with a 200 - the
        // same thing an account with no photo gets. Framing it would cut a
        // one-pixel picture and post it over the photo that is still there.
        stubTheBrowser(() => pictureReply(BLANK_AVATAR_ETAG));

        render(<ProfilePicturesCard {...PERSON} hasPhoto hasBanner />);
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Edit photo" }));
        await user.click(await screen.findByRole("menuitem", { name: "Reframe" }));

        expect(await screen.findByText("Could not open that picture again")).toBeDefined();
        expect(screen.queryByText("Frame the picture")).toBeNull();
    });
});
