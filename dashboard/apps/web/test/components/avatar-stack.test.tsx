/**
 * The faces on a task. One person assigned drew a dark oval behind their face -
 * the cutout ring on a wrapper as tall as the line of text rather than the face -
 * which read as a second, hidden assignee.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/presence-store", () => ({ usePresence: () => null }));
vi.mock("@/components/profile-style-store", () => ({ useProfileStyle: () => null }));
vi.mock("@/components/photo-access", () => ({ usePhotoOpenable: () => false }));

const { AvatarStack } = await import("@/components/avatar");

function wrappers(markup: string): string[] {
    return [...markup.matchAll(/<span class="([^"]*)" title="[^"]*"><span title=/g)].map(
        (match) => match[1]!
    );
}

const ADA = { id: "u1", name: "Ada Lovelace" };
const ALAN = { id: "u2", name: "Alan Turing" };

describe("AvatarStack", () => {
    it("draws one face as one face: sized to it, with no cutout ring", () => {
        const markup = renderToStaticMarkup(<AvatarStack people={[ADA]} size={20} />);
        const found = wrappers(markup);
        expect(found).toHaveLength(1);
        expect(found[0]).toContain("inline-flex");
        expect(found[0]).not.toContain("ring-");
        expect(markup.match(/data-avatar/g)).toHaveLength(1);
    });

    it("parts overlapping faces with the cutout", () => {
        const markup = renderToStaticMarkup(<AvatarStack people={[ADA, ALAN]} size={20} />);
        const found = wrappers(markup);
        expect(found).toHaveLength(2);
        for (const classes of found) {
            expect(classes).toContain("inline-flex");
            expect(classes).toContain("ring-2");
        }
    });

    it("counts a face and the rest as overlapping", () => {
        const markup = renderToStaticMarkup(
            <AvatarStack people={[ADA, ALAN]} max={1} size={20} />
        );
        expect(wrappers(markup)[0]).toContain("ring-2");
        expect(markup).toContain("+1");
    });

    it("draws nothing for nobody", () => {
        expect(renderToStaticMarkup(<AvatarStack people={[]} />)).toBe("");
    });
});
