/**
 * The preview line, against the mail that broke it.
 *
 * Every case here is a line somebody actually read in their own inbox, copied
 * out of it. They are kept as a set because they fail for three different
 * reasons and fixing one has twice now left the other two on screen:
 *
 * - the part was base64 from end to end and nothing decoded it,
 * - the part was quoted-printable and the only escapes in it stood for a space
 *   or an equals sign, which the decoder was not looking for,
 * - the part was HTML, cut off after a few kilobytes, so it had no closed tag
 *   in it at all - and very often began inside the stylesheet.
 */

import { snippetFrom } from "./mailbox.js";
import { describe, expect, it } from "vitest";

describe("mail that came out unreadable", () => {
    it("reads a part that is base64 from end to end", () => {
        // What a bank's mail looked like in the list: one run of base64.
        const encoded = Buffer.from(
            "<html><head></head><body><p>JAVIER, recuerda las fechas de los proximos pagos.</p></body></html>",
            "utf8"
        ).toString("base64");
        expect(snippetFrom(encoded)).toBe("JAVIER, recuerda las fechas de los proximos pagos.");
    });

    it("reads a run of base64 the preview cut mid-group", () => {
        // A preview is a slice of a part - a few thousand bytes off the front -
        // and a slice of base64 almost never ends where a group does. Requiring
        // one meant every sender who encodes their text part kept its
        // `ICAgICAg` in the list, which is what a bank's payment reminders
        // looked like.
        const whole = Buffer.from(
            "Recuerda las fechas de los proximos pagos de tu compra. Consulta el calendario en tu cuenta.",
            "utf8"
        ).toString("base64");
        const cut = whole.slice(0, whole.length - 3);
        expect(snippetFrom(cut)).toContain("Recuerda las fechas de los proximos pagos");
    });

    it("says nothing for a part that was only ever indentation", () => {
        // The other half of the same message: a plain part carrying spaces and
        // nothing else. Blank is the honest answer, and the list falls back to
        // the message's other half for something to show.
        const spaces = Buffer.from(" ".repeat(120), "utf8").toString("base64");
        expect(snippetFrom(spaces)).toBe("");
    });

    it("leaves a word alone that happens to look like base64", () => {
        // The guard that stops this being a decoder pointed at prose.
        expect(snippetFrom("Confirmacion de tu pedido en la tienda de electronica")).toBe(
            "Confirmacion de tu pedido en la tienda de electronica"
        );
    });

    it("undoes escapes that stand for a space or an equals sign", () => {
        // The two commonest escapes there are, and both stand for a perfectly
        // printable byte - so a decoder looking only for accents left these.
        expect(snippetFrom("=20 =20 =20 Paquete en aduanas")).toBe("Paquete en aduanas");
        expect(
            snippetFrom(
                "Mis pedidos https://www.amazon.es/gp/css/order-history?ref_=3Dfed_yo_default"
            )
        ).toBe("Mis pedidos https://www.amazon.es/gp/css/order-history?ref_=fed_yo_default");
    });

    it("still leaves prose with one equals sign in it alone", () => {
        expect(snippetFrom("la mesa mide width=50cm de ancho")).toBe(
            "la mesa mide width=50cm de ancho"
        );
    });

    it("drops a stylesheet the preview begins in the middle of", () => {
        const cut = `/* Mobile Styles */ @media only screen and (max-device-width: 480px) { body{ min-height:620px!important;} table[class~=apple_container_full] * {-webkit-text-size-adjust:none; } } Decision on refund request`;
        expect(snippetFrom(cut)).toBe("Decision on refund request");
    });

    it("comes back empty when the stylesheet is all there was room for", () => {
        // Which is what this message actually looked like: four kilobytes of
        // Apple's stylesheet and not one word of the message. An empty line is
        // the honest answer, and it is what every other client shows.
        const all = `/* Mobile Styles */ @media only screen and (max-device-width: 480px) { body{ min-height:620px!important;} table[class~=apple_container_full] * {-webkit-text-size-adjust:none;`;
        expect(snippetFrom(all)).toBe("");
    });

    it("drops a style block the truncation never closed", () => {
        const cut = "<html><head><style>.a{color:red} .b{color:blue}";
        expect(snippetFrom(cut)).toBe("");
    });

    it("drops a tag the truncation cut in half", () => {
        expect(snippetFrom("Informacion sobre tu proxima cuota <meta http-")).toBe(
            "Informacion sobre tu proxima cuota"
        );
        expect(snippetFrom("Cofidis, cuenta con nosotros <div sty")).toBe(
            "Cofidis, cuenta con nosotros"
        );
    });

    it("reads a message that is markup with no closed tag in it", () => {
        // `looksLikeMarkup` used to want a complete tag, so a fragment like this
        // was passed through untouched.
        expect(snippetFrom("<p>Hola<br")).toBe("Hola");
    });

    it("leaves a plain sentence exactly as it is", () => {
        const plain =
            "Tal y como nos comenta Albert, reenviamos el email de nuevo reajustando el hilo.";
        expect(snippetFrom(plain)).toBe(plain);
    });

    it("leaves prose with an angle bracket in it readable", () => {
        // Not markup, and mangling it would be worse than leaving it.
        expect(snippetFrom("el resultado es 5 > 3 y 2 < 4")).toBe("el resultado es 5 > 3 y 2 < 4");
    });

    it("never replaces a line with something worse than it found", () => {
        // Every decode here is guarded on what comes out reading as text. A
        // wrong guess has to leave the line alone.
        for (const line of [
            "Your Epic Games Receipt",
            "Osintly Your free trial ends on September 9, 2026",
            "PIN: 584460989",
            "0082800082808877483071001"
        ]) {
            expect(snippetFrom(line), line).toBe(line);
        }
    });

    it("is still safe to run twice, which is what repairs a stored one", () => {
        const once = snippetFrom("=20 =20 Hola Mar=C3=ADa <b>Jos=C3=A9</b>");
        expect(once).toBe("Hola María José");
        expect(snippetFrom(once)).toBe(once);
    });
});

describe("a preview stored before any of this existed", () => {
    /** A payment confirmation, as one lender's server sends it: the whole
     *  message is one base64 part, and what the list stored was a slice of it. */
    const html =
        '<html><head><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN">' +
        "<body><p>Tu pago con Paga en 4 en AMAZON ha sido aceptado.</p></body></html>";
    const wrapped = Buffer.from(html, "utf8")
        .toString("base64")
        .replace(/(.{72})/g, "$1 ");

    it("is read back when the whole slice was kept", () => {
        expect(snippetFrom(wrapped)).toContain("Paga en 4");
    });

    it("is read back when the slice was cut short and ellipsised", () => {
        // What a row written before the base64 repair existed actually holds:
        // 200 characters of base64 with the list's own ellipsis on the end. The
        // ellipsis is not base64, so the repair refused the whole line and the
        // reader kept looking at `PGh0bWw+PGhlYWQ+`.
        const stored = `${wrapped.slice(0, 199)}…`;
        expect(snippetFrom(stored)).toContain("Paga en 4");
        expect(snippetFrom(stored)).not.toContain("PGh0bWw");
    });

    it("leaves an ordinary sentence that happens to end in an ellipsis alone", () => {
        expect(snippetFrom("Te escribo por lo de ayer…")).toBe("Te escribo por lo de ayer…");
    });
});

describe("the second attempt at a slice that stripped to nothing", () => {
    it("still refuses a stylesheet that never closes", () => {
        // The fallback exists because an unclosed `<head>` takes the message
        // with it. It must not become a way back in for the thing the first
        // pass was written to remove: an unclosed `<style>` holds no words at
        // all, so keeping it puts `@import url(...)` under somebody's subject
        // and calls it a preview.
        const cut =
            '<html><head><style>@import url("https://example.test/e.css");' +
            "@font-face{font-family:X;src:url(y)}";
        const line = snippetFrom(cut);
        expect(line).not.toContain("@import");
        expect(line).not.toContain("example.test");
    });

    it("still refuses a script that never closes", () => {
        const cut = "<html><head><script>var track='https://example.test/p';window.x=1";
        expect(snippetFrom(cut)).not.toContain("example.test");
    });

    it("keeps the words an unclosed head was holding", () => {
        const cut = "<html><head><body><p>Tu pago ha sido aceptado.</p>";
        expect(snippetFrom(cut)).toContain("Tu pago ha sido aceptado.");
    });
});

describe("a run that looks like base64 and is not", () => {
    it("leaves an opaque token alone rather than decoding it to nonsense", () => {
        // A long identifier is spelt out of the same alphabet base64 is, so it
        // passes every test up to the decode - and what comes back is one
        // replacement character per byte that was not UTF-8. Counting those as
        // readable is how a line somebody could read became a wall of `<?>`.
        const token =
            "kvD8ndPS210vk6Knis48hyZy9WxFZvGydbd8heUzZg5xevjWUUO7XaabTbM5" +
            "ZHonPbyi8T3hAXrfwRbE3lP3qPmdfmblyfcagoTm";
        expect(snippetFrom(token)).toBe(token);
        expect(snippetFrom(`${token}…`)).toBe(`${token}…`);
    });
});
