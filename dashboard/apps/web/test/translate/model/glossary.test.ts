/**
 * Glossaries and the never-translate list: terms protected on the way into an
 * engine and restored on the way out, the stored lists read whole, CSV in and
 * out.
 */

import { describe, expect, it } from "vitest";
import {
    ENTRIES_MAX,
    fromCsv,
    glossaryInput,
    keepInput,
    protect,
    readEntries,
    readTerms,
    restore,
    toCsv,
    withTerms,
    type Terms
} from "@polaris-app/translate/src/model/glossary";

/** An engine that leaves placeholders alone and upper-cases nothing else: identity. */
const echo = async (texts: string[]) => ({ texts });

/** An engine that "translates" by swapping known words and keeps the rest. */
function fakeEngine(words: Record<string, string>) {
    return async (texts: string[]) => ({
        texts: texts.map((text) =>
            text.replace(/[\p{L}]+/gu, (word) => words[word.toLowerCase()] ?? word)
        )
    });
}

const terms = (entries: [string, string][], keep: string[] = []): Terms => ({
    entries: entries.map(([source, target]) => ({ source, target })),
    keep
});

describe("protect and restore", () => {
    it("puts the glossary's wording where the term was", async () => {
        const answer = await withTerms(
            ["The dashboard is ready."],
            terms([["dashboard", "panel de control"]]),
            fakeEngine({ the: "el", is: "está", ready: "listo" })
        );
        expect(answer.texts).toEqual(["el panel de control está listo."]);
        expect(answer.glossaryUsed).toBe(true);
    });

    it("says which of the texts a term was found in", async () => {
        const answer = await withTerms(
            ["The dashboard.", "Nothing here.", "Dashboard"],
            terms([["dashboard", "panel"]]),
            echo
        );
        expect(answer.usedIn).toEqual([true, false, true]);
        const none = await withTerms(["The dashboard."], null, echo);
        expect(none.usedIn).toEqual([false]);
    });

    it("keeps a never-translate word exactly as it was written", async () => {
        const answer = await withTerms(
            ["Open Polaris and polaris.", "POLARIS"],
            terms([], ["Polaris"]),
            fakeEngine({ open: "abre", polaris: "estrella", and: "y" })
        );
        expect(answer.texts).toEqual(["abre Polaris y polaris.", "POLARIS"]);
    });

    it("matches in any case and carries the capital over", () => {
        const shielded = protect(
            ["Server down. the server is up. SERVER!"],
            terms([["server", "servidor"]])
        );
        expect(restore(shielded.texts, shielded)).toEqual([
            "Servidor down. the servidor is up. SERVIDOR!"
        ]);
    });

    it("matches whole words only, next to punctuation", () => {
        const shielded = protect(
            ["cat, (cat) cat. «cat» concat cats cat's"],
            terms([["cat", "gato"]])
        );
        expect(restore(shielded.texts, shielded)).toEqual([
            "gato, (gato) gato. «gato» concat cats gato's"
        ]);
    });

    it("prefers the longest term", () => {
        const shielded = protect(
            ["New York City and New York"],
            terms([
                ["New York", "Nueva York"],
                ["New York City", "Ciudad de Nueva York"]
            ])
        );
        expect(restore(shielded.texts, shielded)).toEqual(["Ciudad de Nueva York and Nueva York"]);
    });

    it("matches a term across a line break or double space", () => {
        const shielded = protect(["New\nYork  is big"], terms([["New York", "Nueva York"]]));
        expect(restore(shielded.texts, shielded)).toEqual(["Nueva York  is big"]);
    });

    it("works with right-to-left text and accented letters", async () => {
        const answer = await withTerms(
            ["שלום Polaris עולם", "café olé"],
            terms([["café", "coffee"]], ["Polaris"]),
            echo
        );
        expect(answer.texts).toEqual(["שלום Polaris עולם", "coffee olé"]);
        // A Hebrew letter right before the term is a letter: no match.
        const inside = protect(["אPolaris"], terms([], ["Polaris"]));
        expect(inside.used).toBe(false);
    });

    it("restores a placeholder the engine spaced out or wrote full-width", () => {
        const shielded = protect(["Polaris"], terms([], ["Polaris"]));
        expect(restore(["⟦ 0 ⟧", "⟦０⟧"], shielded)).toEqual(["Polaris", "Polaris"]);
        // One it never made is left as it is.
        expect(restore(["⟦7⟧"], shielded)).toEqual(["⟦7⟧"]);
    });

    it("treats regex characters in a term literally", () => {
        const shielded = protect(["C++ and C#, not Cxx"], terms([["C++", "C plus plus"]], ["C#"]));
        expect(restore(shielded.texts, shielded)).toEqual(["C plus plus and C#, not Cxx"]);
    });

    it("sends the text untouched when nothing applies", async () => {
        const answer = await withTerms(["Hello"], { entries: [], keep: [] }, echo);
        expect(answer).toEqual({ texts: ["Hello"], glossaryUsed: false });
        const none = await withTerms(["Hello"], terms([["bye", "adiós"]]), echo);
        expect(none.glossaryUsed).toBe(false);
    });
});

describe("input", () => {
    it("normalizes names and terms and keeps one entry per term", () => {
        const parsed = glossaryInput.parse({
            name: "  Product   terms ",
            from: "en",
            to: "es",
            isDefault: true,
            entries: [
                { source: " Server ", target: "servidor" },
                { source: "server", target: "Servidor" }
            ]
        });
        expect(parsed.name).toBe("Product terms");
        expect(parsed.entries).toEqual([{ source: "server", target: "Servidor" }]);
    });

    it("refuses a blank term, the same language twice, and too many entries", () => {
        const base = { name: "G", from: "en", to: "es", isDefault: false };
        expect(
            glossaryInput.safeParse({ ...base, entries: [{ source: " ", target: "x" }] }).success
        ).toBe(false);
        expect(glossaryInput.safeParse({ ...base, to: "en", entries: [] }).success).toBe(false);
        const many = Array.from({ length: ENTRIES_MAX + 1 }, (_, i) => ({
            source: `t${i}`,
            target: "x"
        }));
        expect(glossaryInput.safeParse({ ...base, entries: many }).success).toBe(false);
        expect(keepInput.parse([" Polaris ", "polaris", "Enigma"])).toEqual(["polaris", "Enigma"]);
    });

    it("reads a stored list whole, dropping what is broken", () => {
        expect(readEntries([{ source: "a", target: "b" }, { source: 1 }, "x", null])).toEqual([
            { source: "a", target: "b" }
        ]);
        expect(readEntries(null)).toEqual([]);
        expect(readTerms(["a", 2, " "])).toEqual(["a"]);
        expect(readTerms({})).toEqual([]);
    });
});

describe("CSV", () => {
    it("round-trips quotes, commas and line breaks", () => {
        const entries = [
            { source: 'say "hi"', target: "di «hola»" },
            { source: "a, b", target: "a; b" },
            { source: "plain", target: "llano" }
        ];
        expect(fromCsv(toCsv(entries))).toEqual({ entries, skipped: 0 });
    });

    it("skips a header, blank and incomplete rows, and takes semicolons or tabs", () => {
        const csv = "﻿source,target\n\nserver;servidor\nlonely\nclient\tcliente\n";
        expect(fromCsv(csv)).toEqual({
            entries: [
                { source: "server", target: "servidor" },
                { source: "client", target: "cliente" }
            ],
            skipped: 1
        });
    });
});
