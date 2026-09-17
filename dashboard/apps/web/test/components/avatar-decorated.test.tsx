// @vitest-environment jsdom

/**
 * Where a face wears the ring its owner chose.
 *
 * Only where somebody is being introduced - their profile, their messages, a
 * room's member list, the list of direct messages. Everywhere else - a mention
 * picker, a group's settings, a table of accounts - the face is drawn plain, the
 * way it is in every other chat client's lists.
 */

import { Avatar } from "@/components/avatar";
import { PlainNames } from "@/components/person-name";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@/components/presence-store", () => ({ usePresence: () => null }));
vi.mock("@/components/photo-access", () => ({ usePhotoOpenable: () => false }));

const asked: (string | null | undefined)[] = [];
vi.mock("@/components/profile-style-store", () => ({
    useProfileStyle: (id: string | null | undefined) => {
        asked.push(id);
        return id ? { decoration: "aurora", nameStyle: null, nameplate: null } : null;
    }
}));

const PERSON = { id: "018f2b7a-0000-7000-8000-00000000000a", name: "Ada Lovelace" };

/** Whether the ring was drawn, which is an SVG behind the face. */
function ringed(container: HTMLElement): boolean {
    return container.querySelector("svg[aria-hidden='true']") !== null;
}

afterEach(() => {
    cleanup();
    asked.length = 0;
});

describe("a face in a list", () => {
    it("is plain unless the caller asks for the ring", () => {
        const { container } = render(<Avatar person={PERSON} size={28} />);
        expect(ringed(container)).toBe(false);
        // And the store is not even asked, so a picker of thirty faces
        // subscribes to nothing.
        expect(asked.filter(Boolean)).toEqual([]);
    });

    it("wears the ring where the caller asks for it", () => {
        const { container } = render(<Avatar decorated person={PERSON} size={28} />);
        expect(ringed(container)).toBe(true);
    });

    it("stays plain on a surface that draws people plainly, asked or not", () => {
        const { container } = render(
            <PlainNames>
                <Avatar decorated person={PERSON} size={28} />
            </PlainNames>
        );
        expect(ringed(container)).toBe(false);
    });

    it("draws a decoration passed in as a preview wherever it is", () => {
        const { container } = render(<Avatar decoration="aurora" person={PERSON} size={28} />);
        expect(ringed(container)).toBe(true);
    });
});
