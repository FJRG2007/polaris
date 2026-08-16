/**
 * Which messages are not worth reporting.
 *
 * The rule exists to keep "hola" out of a moderation queue, and it errs one way
 * on purpose: a message it does not recognize is reportable. So the cases that
 * matter here are the ones where a real message must NOT be swallowed - a
 * greeting with a threat after it, a name, a link, anything longer than a
 * pleasantry.
 */

import { describe, expect, it } from "vitest";
import { isPleasantry } from "./pleasantries.js";

describe("a message with nothing in it to act on", () => {
    it("catches the greetings", () => {
        for (const text of ["hola", "Hola!", "hi", "Hello", "hey", "alo", "buenas", "Ey"]) {
            expect(isPleasantry(text), text).toBe(true);
        }
    });

    it("catches the thanks", () => {
        for (const text of ["gracias", "Muchas gracias", "thanks", "Thank you", "thx", "ty"]) {
            expect(isPleasantry(text), text).toBe(true);
        }
    });

    it("catches the ones typed the way people type them", () => {
        for (const text of ["holaaaaa", "heyy", "HOLA!!!", "hola :)", "buenos días", "hi there"]) {
            expect(isPleasantry(text), text).toBe(true);
        }
    });

    it("catches a greeting addressed to the room", () => {
        for (const text of ["hola a todos", "buenas tardes equipo", "thank you all", "hey guys"]) {
            expect(isPleasantry(text), text).toBe(true);
        }
    });

    it("catches the acknowledgements", () => {
        for (const text of ["ok", "vale", "perfecto", "listo", "okay!"]) {
            expect(isPleasantry(text), text).toBe(true);
        }
    });
});

describe("a message somebody may report", () => {
    it("lets a greeting with something after it through", () => {
        for (const text of [
            "hola, te voy a encontrar",
            "hi, send me your password",
            "gracias por nada, imbecil",
            "hey check this http://spam.example"
        ]) {
            expect(isPleasantry(text), text).toBe(false);
        }
    });

    it("lets anything with an unfamiliar word through", () => {
        for (const text of ["hola javier", "thanks Ada", "ok pero no", "buenas noches cabron"]) {
            expect(isPleasantry(text), text).toBe(false);
        }
    });

    it("lets a message with no words at all through", () => {
        // A picture, a recording or a file - the message is what is attached,
        // and that is exactly what somebody would be reporting.
        for (const text of ["", "   ", "🔪", "..."]) {
            expect(isPleasantry(text), JSON.stringify(text)).toBe(false);
        }
    });

    it("lets a sentence made of small words through", () => {
        expect(isPleasantry("por favor")).toBe(false);
        expect(isPleasantry("how are you")).toBe(false);
    });

    it("lets anything longer than a greeting through", () => {
        expect(isPleasantry("hola hola hola hola hola hola hola hola hola")).toBe(false);
    });
});
