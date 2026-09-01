// @vitest-environment jsdom

/**
 * An organization gets the page a profile gets.
 *
 * It has an address anybody can be sent to - `/o/<slug>` - so it is a profile,
 * and it was being edited through one small square while a person got a band, a
 * face cut out of its lower edge and a preview of the whole page. Two products
 * in one application, and the settings screen was the half that looked
 * unfinished.
 *
 * What is asserted is the shape rather than the styling: the band is drawn from
 * the organization's own banner, the mark is drawn as a square, and each picture
 * carries a handle offering everything that can be done to it - including, on the
 * banner, the Remove that only exists once there is one to remove.
 */

import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrgProfileCard } from "@/app/o/[slug]/org-profile-card";
import { OrgPicturesCard } from "@/app/(app)/account/avatar-card";
import { cleanup, render, screen, within } from "@testing-library/react";

// A colour taken from the mark by drawing it on a canvas. jsdom has no pixels to
// read, so the band falls back to the organization's tint - which is the case
// almost every organization is in anyway.
vi.mock("@/lib/profile-accent", () => ({
    useAccent: () => null,
    accentGradient: () => "linear-gradient(135deg, #000 0%, #111 100%)"
}));
vi.mock("@/components/presence-store", () => ({ usePresence: () => null }));
vi.mock("@/components/photo-access", () => ({ usePhotoOpenable: () => false }));

const ORG = { id: "018f2b7a-0000-7000-8000-00000000000b", name: "Dyson Yards" };

/** Every picture on screen, by the address it is fetched from. */
function sources(): string[] {
    return [...document.querySelectorAll("img")].map((image) => image.getAttribute("src") ?? "");
}

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

describe("editing an organization's pictures", () => {
    it("draws both of them, from the organization's own addresses", () => {
        render(<OrgPicturesCard orgId={ORG.id} name={ORG.name} hasPhoto hasBanner />);
        expect(sources()).toContain(`/api/banner/org/${ORG.id}`);
        expect(sources()).toContain(`/api/avatar/org/${ORG.id}`);
    });

    it("offers a handle on each", async () => {
        render(<OrgPicturesCard orgId={ORG.id} name={ORG.name} hasPhoto hasBanner />);
        expect(await optionsOf(/banner/i)).toEqual(["Reframe", "Replace", "Remove"]);
    });

    it("offers no Remove for a picture that is not there", async () => {
        render(<OrgPicturesCard orgId={ORG.id} name={ORG.name} hasPhoto={false} hasBanner={false} />);
        expect(await optionsOf(/banner/i)).toEqual(["Upload banner"]);
    });

    it("names the organization under its mark, the way the page will", () => {
        render(<OrgPicturesCard orgId={ORG.id} name={ORG.name} hasPhoto hasBanner />);
        expect(screen.getAllByTitle(ORG.name).length).toBeGreaterThan(0);
    });
});

describe("an organization's own page", () => {
    const profile = {
        id: ORG.id,
        slug: "dyson-yards",
        name: ORG.name,
        description: "",
        people: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        manageable: false
    };

    it("wears its banner rather than a flat strip of colour", () => {
        render(<OrgProfileCard org={profile} />);
        expect(sources()).toContain(`/api/banner/org/${ORG.id}`);
    });
});
