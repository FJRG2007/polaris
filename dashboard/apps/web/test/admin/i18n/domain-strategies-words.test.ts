/**
 * The exposure strategies, in the reader's words.
 *
 * `lib/domain-strategies` keeps each strategy's and each approach's English for
 * the server side and its tests; the setup wizard says them through the `admin`
 * catalog by id. The English catalog is held to the library word for word here,
 * list lines included, and a sample is read in Spanish.
 */

import { describe, expect, it } from "vitest";
import { translatorFor } from "@/lib/i18n/translate";
import {
    APPROACH_META,
    approachesFor,
    EXPOSURE_STRATEGIES,
    STRATEGY_META,
    strategiesFor,
    type ExposureApproach
} from "@/lib/domain-strategies";
import { approachWords, strategyNote, strategyWords } from "@/app/(app)/admin/domains/strategy-words";

const english = translatorFor("en-US", "admin");
const spanish = translatorFor("es-ES", "admin");
const ENVIRONMENTS = ["vps", "cloud", "home-nat", "home-cgnat", "unknown"] as const;

describe("the English library writes", () => {
    it("names every strategy as the library does", () => {
        for (const id of EXPOSURE_STRATEGIES) {
            const words = strategyWords(english, id);
            const meta = STRATEGY_META[id];
            expect(words).toEqual({
                label: meta.label,
                summary: meta.summary,
                dependency: meta.dependency,
                requires: meta.requires
            });
        }
    });

    it("names both approaches as the library does", () => {
        for (const id of ["ports", "tunnel"] as ExposureApproach[]) {
            const meta = APPROACH_META[id];
            expect(approachWords(english, id)).toEqual({
                label: meta.label,
                summary: meta.summary,
                pros: meta.pros,
                cons: meta.cons
            });
        }
    });

    it("gives every note back as the ranking wrote it", () => {
        for (const environment of ENVIRONMENTS) {
            for (const option of strategiesFor(environment).options) {
                expect(strategyNote(english, option)).toBe(option.note);
            }
            for (const option of approachesFor(environment).options) {
                expect(strategyNote(english, option)).toBe(option.note);
            }
        }
    });
});

describe("in Spanish", () => {
    it("reads a strategy and a note", () => {
        expect(strategyWords(spanish, "duckdns").summary).toContain("<nombre>.duckdns.org");
        expect(approachWords(spanish, "tunnel").label).toBe("Publicar mediante un túnel");
        const cgnat = strategiesFor("home-cgnat").options.find((option) => option.id === "own-domain");
        expect(cgnat && strategyNote(spanish, cgnat)).toContain("NAT del operador");
    });
});
