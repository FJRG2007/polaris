/**
 * The integrations catalog, in the reader's words.
 *
 * `lib/integrations/registry` keeps every service's English; the Integrations
 * screen says it through the `admin` catalog by slug. The English catalog is
 * held to the registry word for word here - every service, every setup step -
 * and a sample is read in Spanish.
 */

import { describe, expect, it } from "vitest";
import { translatorFor } from "@/lib/i18n/translate";
import { INTEGRATION_CATEGORIES, SERVICE_INTEGRATIONS } from "@/lib/integrations/registry";
import { categoryWords, integrationWords } from "@/lib/integrations/registry-words";

const english = translatorFor("en-US", "admin");
const spanish = translatorFor("es-ES", "admin");

describe("the English registry writes", () => {
    it("says every service as the registry does", () => {
        for (const entry of SERVICE_INTEGRATIONS) {
            const words = integrationWords(english, entry);
            expect(words.summary).toBe(entry.summary);
            expect(words.description).toBe(entry.description);
            expect(words.apiKeyLabel).toBe(entry.apiKeyLabel);
            expect(words.apiKeyHelp).toBe(entry.apiKeyHelp);
            expect(words.setupLinks).toEqual(entry.setupLinks);
        }
    });

    it("names every group as the registry does", () => {
        for (const category of INTEGRATION_CATEGORIES) {
            expect(categoryWords(english, category)).toEqual({ name: category.name, hint: category.hint });
        }
    });

    it("has words for every service on the screen", () => {
        for (const entry of SERVICE_INTEGRATIONS) {
            expect(integrationWords(spanish, entry).summary).not.toBe(entry.summary);
        }
    });
});

describe("in Spanish", () => {
    it("reads a service, a step and a group", () => {
        const duck = SERVICE_INTEGRATIONS.find((entry) => entry.slug === "duckdns");
        expect(duck && integrationWords(spanish, duck).description).toContain("<nombre>.duckdns.org");
        const google = SERVICE_INTEGRATIONS.find((entry) => entry.slug === "google");
        expect(google && integrationWords(spanish, google).setupLinks?.[4]?.label).toBe("Activar la API de Calendar");
        expect(categoryWords(spanish, INTEGRATION_CATEGORIES[0]!).name).toBe("Seguridad");
    });
});
