/**
 * Reading what a mail server actually hands over.
 *
 * A regression test for the bug that made every preview line in a Spanish thread
 * read as `Mar=C3=ADa` and `=C2=BFqu=C3=A9 tal?`. A message part is wrapped in
 * quoted-printable or base64 for the journey and carries its own character set,
 * and the list was reading the bytes straight - so every accent in every
 * language became noise.
 *
 * The cases here are the ones that actually occur: a real quoted-printable line
 * with a soft break in it, base64 wrapped at 76 characters, Latin-1 from an
 * older client, and the malformed input that must not take the message down
 * with it.
 */

import { describe, expect, it } from "vitest";
import { decodePart, unflow } from "@/lib/mailbox/decode";

describe("quoted-printable", () => {
    it("reads the accents that were coming out as noise", () => {
        const raw = Buffer.from("Hola Mar=C3=ADa, =C2=BFqu=C3=A9 tal?", "latin1");
        expect(decodePart(raw, { encoding: "quoted-printable", charset: "utf-8" })).toBe(
            "Hola María, ¿qué tal?"
        );
    });

    it("joins the soft line breaks the sender added to stay under 76 characters", () => {
        const raw = Buffer.from("Gracias por ponerme en contacto con Albert=\r\n. Un saludo", "latin1");
        expect(decodePart(raw, { encoding: "quoted-printable", charset: "utf-8" })).toBe(
            "Gracias por ponerme en contacto con Albert. Un saludo"
        );
    });

    it("keeps a lone = rather than losing the rest of the message over it", () => {
        const raw = Buffer.from("2 = 2 and =20 is a space", "latin1");
        expect(decodePart(raw, { encoding: "quoted-printable", charset: "utf-8" })).toBe(
            "2 = 2 and   is a space"
        );
    });
});

describe("base64", () => {
    it("reads a part wrapped at 76 characters", () => {
        const wrapped = Buffer.from(Buffer.from("Hola María", "utf8").toString("base64"), "ascii");
        expect(decodePart(wrapped, { encoding: "base64", charset: "utf-8" })).toBe("Hola María");
    });
});

describe("character sets", () => {
    it("reads a Latin-1 part as Latin-1", () => {
        const raw = Buffer.from("Se\u00f1or", "latin1");
        expect(decodePart(raw, { encoding: "8bit", charset: "iso-8859-1" })).toBe("Señor");
    });

    it("falls back to UTF-8 for a charset nothing has heard of", () => {
        const raw = Buffer.from("plain", "utf8");
        expect(decodePart(raw, { encoding: "", charset: "x-nonsense" })).toBe("plain");
    });

    it("leaves an unencoded part alone", () => {
        expect(decodePart(Buffer.from("María", "utf8"), {})).toBe("María");
    });
});

describe("format=flowed", () => {
    it("puts a paragraph back together instead of leaving it in pieces", () => {
        expect(unflow("This is one long \nparagraph cut in two.")).toBe(
            "This is one long paragraph cut in two."
        );
    });

    it("keeps a line the author actually ended", () => {
        expect(unflow("First line\nSecond line")).toBe("First line\nSecond line");
    });
});
