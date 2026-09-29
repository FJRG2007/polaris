/**
 * Tools, in Spanish.
 *
 * The catalog names each group and what it does in English, because search and
 * the tests read it. The front page says it through the `tools` catalog, keyed
 * by the group's id and the line's place, so the English catalog is held to the
 * list here: a line added to one and not the other would show its key.
 */

import { describe, expect, it } from "vitest";
import { translatorFor } from "@/lib/i18n/translate";
import type { NamespaceKey } from "@/lib/i18n/types";
import { TOOL_GROUPS } from "@/lib/tools/catalog";

const english = translatorFor("en-US", "tools");
const spanish = translatorFor("es-ES", "tools");

describe("the Tools catalog", () => {
    it("says every group and every line as the catalog does", () => {
        for (const group of TOOL_GROUPS) {
            expect(english(`groups.${group.id}.name` as NamespaceKey<"tools">)).toBe(group.name);
            group.does.forEach((line, index) => {
                expect(english(`groups.${group.id}.does.${index}` as NamespaceKey<"tools">)).toBe(line);
            });
        }
    });

    it("reads in Spanish", () => {
        expect(spanish("groups.links.name")).toBe("Enlaces y texto");
        expect(spanish("images.size", { width: 800, height: 600, weight: "120 kB" })).toBe("800 x 600, 120 kB");
    });
});
