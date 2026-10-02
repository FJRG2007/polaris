/**
 * The lists that moved off Fuse onto the shared search, each asked the
 * operator's question: a word that is in nothing answers nothing.
 *
 * Every one of these used to hand its rows to Fuse at a threshold of 0.3 to 0.4
 * with `ignoreLocation`, which is how a word in no task brought back a screenful
 * of tasks. What is pinned here is each list's own fields - the ones it reads
 * and the one it forgives a typo in - rather than the matcher, which core tests.
 */

import { POLARIS_APPS } from "@/lib/apps";
import { describe, expect, it } from "vitest";
import { searchEmoji } from "@/lib/chat/emoji";
import { searchItems } from "@polaris/core/search-text";
import { COMMAND_ENTRY_FIELDS, navigationEntries } from "@/lib/search/entries";
import { NAME_SEARCH, PATH_SEARCH, parseSearch } from "@/app/(app)/drive/search-query";

describe("the emoji search", () => {
    it("finds an emoji by a word of its name, or a typo in one", () => {
        expect(searchEmoji("thumbs").map((entry) => entry.char)).toContain("👍");
        expect(searchEmoji("thumbsup").map((entry) => entry.char)[0]).toBe("👍");
        expect(searchEmoji("smiel").length).toBeGreaterThan(0);
    });

    it("answers nothing for a word no emoji is called", () => {
        expect(searchEmoji("kubernetes")).toEqual([]);
    });
});

describe("the files search", () => {
    const entries = [
        { name: "Presupuesto reforma.pdf", path: "/documentos/obra/Presupuesto reforma.pdf" },
        { name: "Canción final.mp3", path: "/musica/Canción final.mp3" },
        { name: "notas.txt", path: "/documentos/notas.txt" }
    ];

    it("finds a file by every word of its name, without its accents", () => {
        const parsed = parseSearch("cancion final");
        expect(searchItems(entries, parsed.fuzzy, NAME_SEARCH).map((entry) => entry.name)).toEqual([
            "Canción final.mp3"
        ]);
    });

    it("finds a nested file by its path", () => {
        const parsed = parseSearch("documentos/notas");
        expect(parsed.pathMode).toBe(true);
        expect(searchItems(entries, parsed.fuzzy, PATH_SEARCH).map((entry) => entry.name)).toEqual(["notas.txt"]);
    });

    it("answers nothing for a name no file has", () => {
        expect(searchItems(entries, parseSearch("factura").fuzzy, NAME_SEARCH)).toEqual([]);
    });
});

describe("the command palette and the shortcut picker", () => {
    const pool = navigationEntries(true, POLARIS_APPS.map((app) => app.id));

    it("puts the page called what was typed first", () => {
        const found = searchItems(pool, "drive", COMMAND_ENTRY_FIELDS);
        expect(found[0]?.href).toBe("/drive");
    });

    it("answers nothing for a word no page is called or described by", () => {
        expect(searchItems(pool, "zanahoria", COMMAND_ENTRY_FIELDS)).toEqual([]);
    });
});
