/**
 * Which glossary a translation uses, what the save action accepts, and the
 * file name an export gets.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris-app/translate/src/actions/translate", () => ({}));

import { csvName } from "@polaris-app/translate/src/screens/glossary-manager";
import { saveGlossaryInput } from "@polaris-app/translate/src/model/glossary";
import { chooseGlossary } from "@polaris-app/translate/src/screens/glossaries";

const summary = (id: string, from: string, to: string, isDefault: boolean) => ({
    id,
    name: id,
    from,
    to,
    isDefault,
    count: 1,
    updatedAt: "2026-11-04T00:00:00.000Z"
});

describe("the glossary a translation uses", () => {
    const shelf = [
        summary("en-es", "en", "es", true),
        summary("en-es-other", "en", "es", false),
        summary("fr-es", "fr", "es", true),
        summary("en-de", "en", "de", true)
    ];

    it("is the pair's default", () => {
        expect(chooseGlossary(shelf, "en", "es")?.id).toBe("en-es");
        expect(chooseGlossary(shelf, "fr", "es")?.id).toBe("fr-es");
    });

    it("is none for a pair without a default", () => {
        expect(chooseGlossary(shelf, "de", "es")).toBeNull();
        expect(chooseGlossary([summary("x", "en", "es", false)], "en", "es")).toBeNull();
    });

    it("is guessed with the source unknown only when one pair into the target has a default", () => {
        expect(chooseGlossary(shelf, null, "de")?.id).toBe("en-de");
        expect(chooseGlossary(shelf, null, "es")).toBeNull();
    });
});

describe("what the save action takes", () => {
    it("is a glossary, an optional id, and nothing else", () => {
        const glossary = { name: " Work ", from: "en", to: "es", isDefault: true, entries: [] };
        expect(saveGlossaryInput.parse(glossary)).toMatchObject({ name: "Work" });
        expect(saveGlossaryInput.safeParse({ ...glossary, id: "nope" }).success).toBe(false);
        expect(saveGlossaryInput.safeParse({ ...glossary, userId: "u2" }).success).toBe(false);
        expect(saveGlossaryInput.safeParse({ ...glossary, to: "en" }).success).toBe(false);
    });
});

describe("an exported glossary's file name", () => {
    it("is the name in letters, digits and dashes", () => {
        expect(csvName("Términos / Marketing 2026")).toBe("terminos-marketing-2026.csv");
        expect(csvName("***")).toBe("glossary.csv");
    });
});
