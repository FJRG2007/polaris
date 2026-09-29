/**
 * Core's refusals, translated where they are shown.
 *
 * English is held to core's own words - the table is keyed by them, so a
 * message core rewords stops being recognised and this fails rather than the
 * screen quietly falling back to English in Spanish.
 */

import { describe, expect, it } from "vitest";
import { translatorFor } from "@/lib/i18n/translate";
import { KNOWN_VALIDATION_MESSAGES, validationMessage } from "@/components/i18n/validation-message";

const en = translatorFor("en-US", "validation");
const es = translatorFor("es-ES", "validation");

describe("validationMessage", () => {
    it("reads every known message back in core's own English", () => {
        for (const message of KNOWN_VALIDATION_MESSAGES) expect(validationMessage(en, message)).toBe(message);
        for (const message of ["At least 3 characters", "At most 120 characters", "Use at least 10 characters"]) {
            expect(validationMessage(en, message)).toBe(message);
        }
    });

    it("translates them into Spanish, counts included", () => {
        expect(validationMessage(es, "Enter a valid email")).toBe("Introduce un correo válido");
        expect(validationMessage(es, "At most 30 characters")).toBe("Como máximo 30 caracteres");
        expect(validationMessage(es, "Use at least 10 characters")).toBe("Usa al menos 10 caracteres");
    });

    it("leaves a message it does not know, and nothing, as they were", () => {
        expect(validationMessage(es, "Something an area wrote")).toBe("Something an area wrote");
        expect(validationMessage(es, undefined)).toBeUndefined();
    });
});
