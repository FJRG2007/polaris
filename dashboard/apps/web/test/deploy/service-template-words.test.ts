/**
 * The one-click templates, in the reader's words.
 *
 * `SERVICE_TEMPLATES` keeps each template's English; the picker says it through
 * the `deploy` catalog by id. The English catalog is held to the template word
 * for word, and every template has its Spanish too.
 */

import { describe, expect, it } from "vitest";
import { SERVICE_TEMPLATES } from "@polaris/core";
import { translatorFor } from "@/lib/i18n/translate";

const english = translatorFor("en-US", "deploy");
const spanish = translatorFor("es-ES", "deploy");

describe("the template picker's words", () => {
    it("says every template in English as the template does", () => {
        for (const template of SERVICE_TEMPLATES) {
            expect(english(`view.template.catalog.${template.id}.description`)).toBe(
                template.description
            );
            expect(english(`view.template.catalog.${template.id}.firstRun`)).toBe(
                template.firstRun
            );
        }
    });

    it("has Spanish for every template, with the variables it names left as they are", () => {
        for (const template of SERVICE_TEMPLATES) {
            const description = spanish(`view.template.catalog.${template.id}.description`);
            const firstRun = spanish(`view.template.catalog.${template.id}.firstRun`);
            expect(description, template.id).not.toBe(
                `view.template.catalog.${template.id}.description`
            );
            expect(description.trim(), template.id).not.toBe("");
            for (const key of template.secrets) {
                if (template.firstRun.includes(key))
                    expect(firstRun, `${template.id}: ${key}`).toContain(key);
            }
        }
    });

    it("writes no long dash in either language", () => {
        for (const template of SERVICE_TEMPLATES) {
            for (const say of [english, spanish]) {
                expect(say(`view.template.catalog.${template.id}.firstRun`)).not.toMatch(/[–—]/);
            }
        }
    });
});
