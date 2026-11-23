/**
 * The @ list is drawn from the people the screen already has, the search only
 * adds to it, and on a phone the list docks above the composer.
 */

import { describe, expect, it } from "vitest";
import { dockFrame, mergeKnown, seededPeople } from "@/components/rich-text/suggestion";
import { knownPeopleOf } from "@/app/(app)/chat/known-people";

const ana = { kind: "user" as const, id: "u-ana", label: "Ana Ruiz", detail: "", image: null };
const bo = { kind: "user" as const, id: "u-bo", label: "Bo Lind", detail: "", image: null };

describe("mergeKnown", () => {
    it("draws the known members before any search has answered", () => {
        expect(mergeKnown("", [ana, bo], []).map((row) => row.id)).toEqual(["u-ana", "u-bo"]);
    });

    it("narrows the known members to what is typed", () => {
        expect(mergeKnown("bo", [ana, bo], []).map((row) => row.id)).toEqual(["u-bo"]);
    });

    it("keeps known rows in place, takes the server's line for them, and appends new people", () => {
        const server = [
            { ...bo, detail: "@bo" },
            { kind: "user" as const, id: "u-cy", label: "Cy", detail: "", image: null }
        ];
        const merged = mergeKnown("", [ana, bo], server);
        expect(merged.map((row) => row.id)).toEqual(["u-ana", "u-bo", "u-cy"]);
        expect(merged[1]!.detail).toBe("@bo");
    });

    it("never drops a known member the answer left out", () => {
        expect(mergeKnown("", [ana], [bo]).map((row) => row.id)).toEqual(["u-ana", "u-bo"]);
    });
});

describe("seededPeople", () => {
    it("lists each person once and skips nameless entries", () => {
        const rows = seededPeople([
            { id: "u-ana", label: "Ana" },
            { id: "u-ana", label: "Ana again" },
            { id: "u-x", label: "  " }
        ]);
        expect(rows.map((row) => row.id)).toEqual(["u-ana"]);
    });
});

describe("knownPeopleOf", () => {
    it("puts members first, then recent authors, never the reader or a webhook", () => {
        const people = knownPeopleOf({
            viewerId: "me",
            members: [{ id: "u-ana", name: "Ana" }],
            authors: [
                { authorId: "u-bo", authorName: "Bo" },
                { authorId: null, authorName: "Webhook" },
                { authorId: "me", authorName: "Me" },
                { authorId: "u-cy", authorName: "Cy" },
                { authorId: "u-ana", authorName: "Ana" }
            ]
        });
        expect(people.map((person) => person.id)).toEqual(["u-ana", "u-cy", "u-bo"]);
    });
});

describe("dockFrame", () => {
    it("spans the visible width and sits on the composer's top edge", () => {
        // iPhone 390x844, keyboard open: 500 px of visual viewport left.
        const frame = dockFrame({ top: 440 }, { width: 390, height: 500, offsetTop: 0, offsetLeft: 0 }, 844);
        expect(frame).toEqual({ left: 0, width: 390, bottom: 404, maxHeight: 250 });
    });

    it("never grows taller than the room above the composer", () => {
        const frame = dockFrame({ top: 200 }, { width: 390, height: 844, offsetTop: 100, offsetLeft: 0 }, 844);
        expect(frame.maxHeight).toBe(96);
    });
});
