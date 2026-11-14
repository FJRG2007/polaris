/**
 * Polar's model as a translation engine. A small model sometimes hands the text
 * back as it came, and the reader was then told "already in this language" about
 * an English email they had asked to read in Spanish. An answer like that is not
 * a translation, so it must not pass as one.
 */

import { describe, expect, it } from "vitest";
import { checkedAnswer, writtenIn } from "@/lib/translate/written-in";

const ENGLISH =
    "We'd like to test your API and show how it does on our site. Our sign-up stopped at the email code.";
const SPANISH =
    "Nos gustaría probar tu API y mostrar cómo funciona en nuestra web. El registro se paró en el código del correo.";

describe("a model's translation, checked", () => {
    it("is refused when English comes back unchanged for a Spanish reader", () => {
        expect(checkedAnswer([ENGLISH], { texts: [ENGLISH], detected: "es" }, "es")).toBeNull();
    });

    it("passes a real translation, with the language the letters show", () => {
        expect(checkedAnswer([ENGLISH], { texts: [SPANISH], detected: "es" }, "es")).toEqual({
            texts: [SPANISH],
            detected: "en"
        });
    });

    it("passes a text that really is already in the target language", () => {
        expect(checkedAnswer([SPANISH], { texts: [SPANISH], detected: "es" }, "es")).not.toBeNull();
    });

    it("trusts the model where the letters cannot tell", () => {
        // Too short to judge, and a target the detector does not vouch for.
        expect(checkedAnswer(["Hi"], { texts: ["Hi"], detected: "en" }, "es")).not.toBeNull();
        expect(checkedAnswer([ENGLISH], { texts: [ENGLISH], detected: "ca" }, "ca")).not.toBeNull();
    });

    it("refuses a batch when any one text was handed back untranslated", () => {
        expect(
            checkedAnswer([SPANISH, ENGLISH], { texts: [SPANISH, ENGLISH], detected: null }, "es")
        ).toBeNull();
    });
});

describe("writtenIn", () => {
    it("names the language of a sentence and nothing for a fragment", () => {
        expect(writtenIn(ENGLISH)).toBe("en");
        expect(writtenIn(SPANISH)).toBe("es");
        expect(writtenIn("ok")).toBeNull();
    });
});
