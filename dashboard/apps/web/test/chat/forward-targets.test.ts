/**
 * What the forward list puts in front of somebody.
 *
 * The complaint this encodes: a person in four servers of thirty channels each
 * opened "forward" and was handed a hundred and twenty rows, with the four
 * people they actually talk to somewhere underneath all of it. A flat list of
 * everything is only usable while you have almost nothing.
 *
 * So the top level is people and groups, a server is one row that opens, and
 * typing goes straight through all of it - because nobody browses to something
 * they can already name. The order of precedence between those three is the
 * whole rule, and it is exactly the kind of thing a later edit undoes quietly.
 */

import { describe, expect, it } from "vitest";
import { listedTargets, type Target } from "@/app/(app)/chat/forward-targets";

const person = (id: string): Target => ({
    id,
    name: id,
    kind: "dm",
    spaceId: null,
    people: [{ id: `${id}-user`, name: id }],
    place: null
});

const channel = (id: string, spaceId: string): Target => ({
    id,
    name: id,
    kind: "text",
    spaceId,
    people: [],
    place: spaceId
});

const ALL: readonly Target[] = [
    person("ada"),
    person("grace"),
    channel("general", "one"),
    channel("random", "one"),
    channel("general", "two")
];

describe("browsing", () => {
    it("shows people and groups at the top level, and no channels at all", () => {
        const listed = listedTargets(ALL, { found: null, inside: null });
        expect(listed.map((target) => target.id)).toEqual(["ada", "grace"]);
    });

    it("shows one server's channels once it is opened, and only that one's", () => {
        const listed = listedTargets(ALL, { found: null, inside: "one" });
        expect(listed.map((target) => target.id)).toEqual(["general", "random"]);
    });

    it("shows nothing for a server with nothing in it", () => {
        expect(listedTargets(ALL, { found: null, inside: "empty" })).toEqual([]);
    });
});

describe("searching", () => {
    it("beats wherever somebody had browsed to", () => {
        // Typing while inside a server has to reach outside it, or a search is
        // just a filter on the thirty rows already on screen.
        const hits = [channel("general", "two")];
        expect(listedTargets(ALL, { found: hits, inside: "one" })).toEqual(hits);
    });

    it("beats the top level too", () => {
        const hits = [channel("random", "one")];
        expect(listedTargets(ALL, { found: hits, inside: null })).toEqual(hits);
    });

    it("shows nothing rather than falling back when a search matches nothing", () => {
        // The fallback would be the top level, which reads as "your search found
        // these people" - the one answer that is actively misleading.
        expect(listedTargets(ALL, { found: [], inside: null })).toEqual([]);
    });
});
