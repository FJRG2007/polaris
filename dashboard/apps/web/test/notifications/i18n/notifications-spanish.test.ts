/**
 * What the notification senders say, in Spanish.
 *
 * The senders and the domain sweep write English - they run inside the
 * notification pass with nobody to ask - and a person reads it on their
 * notifications screen or receives it as the alert itself. The English catalog
 * is held to those sentences here, and a sample of each is read in Spanish.
 */

import { describe, expect, it } from "vitest";
import { translatorFor } from "@/lib/i18n/translate";
import { domainHealthMessage } from "@/lib/notifications/domain-events";
import { deliveryText, KNOWN_DELIVERY_SENTENCES } from "@/lib/notifications/delivery-words";

const english = translatorFor("en-US", "notices");
const spanish = translatorFor("es-ES", "notices");
const englishWords = translatorFor("en-US", "components");
const spanishWords = translatorFor("es-ES", "components");

const LABELS = ["shop.example.com", "blog.example.com", "api.example.com", "docs.example.com"];

describe("the English the senders write", () => {
    it("comes back exactly as it went in", () => {
        const shaped = ["Twilio refused the message (HTTP 400).", "The endpoint answered HTTP 502."];
        for (const message of [...KNOWN_DELIVERY_SENTENCES, ...shaped]) {
            expect(deliveryText(englishWords, message)).toBe(message);
        }
    });

    it("words a domain alert the same with or without a reader", () => {
        expect(domainHealthMessage("down", [LABELS[0]!], "HTTP 502", english)).toEqual(
            domainHealthMessage("down", [LABELS[0]!], "HTTP 502")
        );
        expect(domainHealthMessage("up", LABELS, null, english)).toEqual(domainHealthMessage("up", LABELS, null));
    });
});

describe("in Spanish", () => {
    it("reads why an alert did not go out", () => {
        expect(deliveryText(spanishWords, "The endpoint is gone (404). It was probably deleted.")).toBe(
            "El endpoint ya no existe (404). Probablemente se borró."
        );
        expect(deliveryText(spanishWords, "The endpoint answered HTTP 502.")).toBe("El endpoint respondió HTTP 502.");
        // Twilio's own explanation stays as Twilio wrote it.
        expect(deliveryText(spanishWords, "The 'To' number is not a valid phone number.")).toBe(
            "The 'To' number is not a valid phone number."
        );
    });

    it("tells a recipient about their domains in their language", () => {
        const one = domainHealthMessage("down", [LABELS[0]!], null, spanish);
        expect(one.title).toBe("Dominio sin servicio: shop.example.com");
        expect(one.body).toContain("Dejó de responder");
        const many = domainHealthMessage("up", LABELS, null, spanish);
        expect(many.title).toBe("4 dominios vuelven a responder");
        expect(many.body).toBe("shop.example.com, blog.example.com, api.example.com y 1 más.");
    });
});
