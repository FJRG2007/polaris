/**
 * The words `@polaris/ui` says on its own.
 *
 * The package draws in English unless it is handed the reader's words, which
 * the dashboard does from the `components` catalog (`ui.*`). The English there
 * is held to the package's own here, word for word, and a sample is read in
 * Spanish.
 */

import { describe, expect, it } from "vitest";
import { ENGLISH_UI_STRINGS } from "@polaris/ui";
import { translatorFor } from "@/lib/i18n/translate";

const english = translatorFor("en-US", "components");
const spanish = translatorFor("es-ES", "components");

describe("the shared components' own words", () => {
    it("are the package's English, word for word", () => {
        const words = ENGLISH_UI_STRINGS;
        expect(english("ui.close")).toBe(words.close);
        expect(english("ui.showPassword")).toBe(words.showPassword);
        expect(english("ui.hidePassword")).toBe(words.hidePassword);
        expect(english("ui.noData")).toBe(words.noData);
        expect(english("ui.noDataInRange")).toBe(words.noDataInRange);
        expect(english("ui.hexColour")).toBe(words.hexColour);
        expect(english("ui.hexOf", { label: "Accent" })).toBe(words.hexOf("Accent"));
        expect(english("ui.unit")).toBe(words.unit);
        expect(english("ui.reply")).toBe(words.reply);
        expect(english("ui.send")).toBe(words.send);
        expect(english("ui.sent")).toBe(words.sent);
        expect(english("ui.dismiss")).toBe(words.dismiss);
        expect(english("ui.couldNotSend")).toBe(words.couldNotSend);
        expect(english("ui.didNotWork")).toBe(words.didNotWork);
        expect(english("ui.openNavigation")).toBe(words.openNavigation);
        expect(english("ui.navigation")).toBe(words.navigation);
        expect(english("ui.resetToDefault")).toBe(words.resetToDefault);
        expect(english("ui.resetLayout")).toBe(words.resetLayout);
        for (const key of ["type", "name", "content", "status", "done", "waiting", "conflict"] as const) {
            expect(english(`ui.dns.${key}`)).toBe(words.dns[key]);
        }
        expect(english("ui.dns.nameOf", { name: "www" })).toBe(words.dns.nameOf("www"));
        expect(english("ui.dns.valueOf", { value: "1.2.3.4" })).toBe(words.dns.valueOf("1.2.3.4"));
    });

    it("read in Spanish", () => {
        expect(spanish("ui.close")).toBe("Cerrar");
        expect(spanish("ui.dns.conflict")).toBe("Apunta a otro sitio");
    });
});
