// @vitest-environment jsdom

/**
 * The two pictures on your profile, edited where you can see them.
 *
 * They were two cards, each with a little preview of its own, and the one
 * question worth answering was in neither of them: whether the face and the band
 * look right together - whether the face lands on a busy part of the picture,
 * whether the colours fight. So the card is the profile itself, at the same
 * proportions, with the buttons for each picture under it.
 *
 * What is asserted is that both pictures are actually drawn here and that each
 * has its own two actions - the failure this replaces is a card that previews
 * one thing and edits another.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ProfilePicturesCard } from "@/app/(app)/account/avatar-card";

// Where somebody is has nothing to do with their photo, and the store behind it
// wants a provider this card is never drawn inside.
vi.mock("@/components/presence-store", () => ({ usePresence: () => null }));

const PERSON = { userId: "018f2b7a-0000-7000-8000-00000000000a", name: "Ada Lovelace" };

afterEach(cleanup);

describe("the profile pictures card", () => {
    it("draws the band and the face together, as the profile does", () => {
        const { container } = render(<ProfilePicturesCard {...PERSON} hasPhoto hasBanner />);
        expect(container.querySelector(`img[src='/api/banner/${PERSON.userId}']`)).not.toBeNull();
        expect(container.querySelector(`img[src='/api/avatar/${PERSON.userId}']`)).not.toBeNull();
        expect(screen.getByText("Ada Lovelace")).toBeDefined();
    });

    it("offers each picture its own replace and remove", () => {
        render(<ProfilePicturesCard {...PERSON} hasPhoto hasBanner />);
        for (const label of ["Replace photo", "Replace banner"]) {
            expect(screen.getByRole("button", { name: label })).toBeDefined();
        }
        expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
    });

    it("offers to upload the one that is not there, and nothing to remove", () => {
        render(<ProfilePicturesCard {...PERSON} hasPhoto={false} hasBanner={false} />);
        expect(screen.getByRole("button", { name: "Upload photo" })).toBeDefined();
        expect(screen.getByRole("button", { name: "Upload banner" })).toBeDefined();
        expect(screen.queryAllByRole("button", { name: "Remove" })).toHaveLength(0);
    });
});
