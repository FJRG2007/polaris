// @vitest-environment jsdom

/**
 * A nameplate is worn where somebody is introduced, not where they are merely
 * somewhere.
 *
 * The report: looking at a call from outside it, the people in it showed up on
 * their custom plates - a gradient behind each face in the "call in progress"
 * band. Those rows say who is in a room; they do not introduce anybody.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/components/profile-style-store", () => ({
    useProfileStyle: () => ({ nameplate: "dusk" }),
    useProfileName: () => null,
    useContactName: () => null
}));

const { PersonRow } = await import("@/components/person-name");

afterEach(() => cleanup());

describe("a person's row", () => {
    it("wears their plate by default", () => {
        render(<PersonRow personId="ada">Ada</PersonRow>);
        expect(screen.getByText("Ada").getAttribute("style") ?? "").toContain("gradient");
    });

    it("wears none where it is told never to", () => {
        render(
            <PersonRow personId="ada" plate="never">
                Ada
            </PersonRow>
        );
        const row = screen.getByText("Ada");
        expect(row.getAttribute("style")).toBeNull();
        expect(row.hasAttribute("data-plated")).toBe(false);
    });
});
