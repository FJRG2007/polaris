/**
 * When the picker under the caret is somebody looking somebody up, and when it
 * is punctuation that happens to be a trigger character.
 *
 * The two triggers allow spaces in their query, which is what lets "@Ana Ruiz"
 * be picked at all - and is also why a query has no natural end. Without a rule
 * for when it has stopped being a search, writing "email me @ the address below"
 * leaves a popup hanging under the rest of the sentence, and a Markdown heading
 * opens the one for work. What is pinned here is that a name still opens it and
 * a sentence no longer does.
 */

import { describe, expect, it } from "vitest";
import { matchesTyped, ordered, queryFits, roomMatches } from "@/components/rich-text/suggestion";

describe("what keeps the mention picker open", () => {
    it("opens on the trigger alone, which is somebody asking for the list", () => {
        expect(queryFits("@", "")).toBe(true);
        expect(queryFits("#", "")).toBe(true);
    });

    it("stays open across a name with a space in it", () => {
        expect(queryFits("@", "Ana")).toBe(true);
        expect(queryFits("@", "Ana ")).toBe(true);
        expect(queryFits("@", "Ana Ruiz")).toBe(true);
        expect(queryFits("@", "ana.ruiz")).toBe(true);
        expect(queryFits("@", "ana@example.com")).toBe(true);
        expect(queryFits("@", "Añez-Ruiz")).toBe(true);
    });

    it("closes when the trigger was punctuation rather than a mention", () => {
        expect(queryFits("@", " ")).toBe(false);
        expect(queryFits("@", " the address below")).toBe(false);
        expect(queryFits("@", ",")).toBe(false);
        expect(queryFits("@", "Ana, and also")).toBe(false);
        expect(queryFits("@", "Ana!")).toBe(false);
        expect(queryFits("@", "Ana  Ruiz")).toBe(false);
    });

    it("closes once the query is a paragraph rather than a name", () => {
        expect(queryFits("@", "a".repeat(61))).toBe(false);
        expect(queryFits("#", "a".repeat(121))).toBe(false);
    });

    it("leaves a title its punctuation, but not a Markdown heading", () => {
        expect(queryFits("#", "Fix the cert, again (urgent)")).toBe(true);
        expect(queryFits("#", " Heading")).toBe(false);
    });
});

describe("a room mention once it is written", () => {
    // Picking @everyone writes "@everyone " as text. The picker allows spaces,
    // so it stayed open over it and offered @everyone again: Enter picked it a
    // second time, added a space, and the message was never sent.
    it("closes the picker the moment the space after it is there", () => {
        expect(queryFits("@", "everyone ")).toBe(false);
        expect(queryFits("@", "here ")).toBe(false);
        expect(queryFits("@", "all ")).toBe(false);
        expect(queryFits("@", "polar ")).toBe(false);
        expect(queryFits("@", "polar")).toBe(true);
        expect(queryFits("@", "All ")).toBe(false);
    });

    it("still offers it while it is being typed", () => {
        expect(queryFits("@", "every")).toBe(true);
        expect(roomMatches("every").map((room) => room.id)).toEqual(["everyone"]);
        expect(roomMatches("al").map((room) => room.id)).toEqual(["everyone"]);
    });

    it("is never offered for a query with a space in it", () => {
        expect(roomMatches("everyone ")).toEqual([]);
        expect(roomMatches("every one")).toEqual([]);
    });

    it("leaves names that only start like one alone", () => {
        expect(queryFits("@", "Allison Ruiz")).toBe(true);
        expect(queryFits("@", "Herenia")).toBe(true);
    });
});

describe("mention picker order and narrowing", () => {
    const person = (id: string, label: string) => ({ kind: "user" as const, id, label, detail: "", image: null });
    const rooms = roomMatches("", { rooms: true, polar: true });

    it("keeps people first until what is typed is plainly a room word or Polar", () => {
        const people = [person("1", "Polina Ruiz")];
        expect(ordered("", people, rooms).map((item) => item.id)).toEqual(["1", "everyone", "here", "polar"]);
        expect(ordered("p", people, roomMatches("p", { rooms: true, polar: true })).map((item) => item.id)).toEqual(["1", "polar"]);
        expect(ordered("pol", people, roomMatches("pol", { rooms: true, polar: true })).map((item) => item.id)).toEqual(["polar", "1"]);
        expect(ordered("al", [], roomMatches("al", { rooms: true, polar: false })).map((item) => item.id)).toEqual(["everyone"]);
    });

    it("narrows rows already found by the start of any word, accents aside", () => {
        expect(matchesTyped("José Ruiz", "jose")).toBe(true);
        expect(matchesTyped("José Ruiz", "ru")).toBe(true);
        expect(matchesTyped("José Ruiz", "jose ru")).toBe(true);
        expect(matchesTyped("ana.garcia", "garc")).toBe(true);
        expect(matchesTyped("José Ruiz", "uiz")).toBe(false);
    });
});
