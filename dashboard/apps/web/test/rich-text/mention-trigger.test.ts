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
import { queryFits } from "@/components/rich-text/suggestion";

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
