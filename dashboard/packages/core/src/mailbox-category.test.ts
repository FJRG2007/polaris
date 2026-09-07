/**
 * Which tab a message belongs under.
 *
 * The cases are drawn from a real inbox, because that is the only way to tell
 * whether a categoriser is any use: the failure mode is not "it is wrong", it is
 * "it is wrong about the one message somebody was looking for".
 *
 * The security tab is held to a higher standard than the rest and tested hardest
 * here, because it is the only one with a consequence: a message put in it can
 * be cleared up automatically if its owner asked for that, so a false positive
 * costs somebody a real message.
 */

import { describe, expect, it } from "vitest";
import { categoriseMail, type CategorisableMessage } from "./mailbox-category.js";

function message(over: Partial<CategorisableMessage> = {}): CategorisableMessage {
    return { subject: "", snippet: "", fromAddress: "", fromName: "", headers: null, ...over };
}

describe("codes and sign-ins", () => {
    it("knows one in every language it is likely to arrive in", () => {
        for (const subject of [
            "Your verification code is 449182",
            "Tu codigo de verificacion",
            "Tu código de verificación es 449182",
            "Confirma tu correo electrónico",
            "Reset your password",
            "Restablecer tu contraseña",
            "Nuevo inicio de sesión en tu cuenta",
            "Sign in to Polaris",
            "Your one-time passcode",
            "Code de vérification",
            "Bestätigungscode",
            "Codice di verifica"
        ]) {
            expect(categoriseMail(message({ subject })), subject).toBe("security");
        }
    });

    it("beats every other tab, whoever sent it", () => {
        // A code from a shop is still a code, and burying it under Promotions is
        // what makes somebody go and read their mail somewhere else.
        expect(
            categoriseMail(
                message({
                    subject: "Your verification code",
                    fromAddress: "no-reply@shop.example",
                    snippet: "50% off everything this weekend",
                    headers: { "list-unsubscribe": "<https://shop.example/out>" }
                })
            )
        ).toBe("security");
    });

    it("does not take an order number for a code", () => {
        // The one that matters most: this message can be deleted automatically.
        expect(
            categoriseMail(
                message({
                    subject: "Tu pedido 402-8837462 ha sido enviado",
                    fromAddress: "envio@amazon.es"
                })
            )
        ).toBe("updates");
        expect(
            categoriseMail(message({ subject: "Invoice 4471 is ready", fromAddress: "billing@shop.example" }))
        ).toBe("updates");
    });

    it("does not take a person mentioning a password for a code", () => {
        expect(
            categoriseMail(
                message({
                    subject: "Re: the wifi",
                    snippet: "I left the password on the fridge",
                    fromAddress: "ana@example.com"
                })
            )
        ).toBe("primary");
    });
});

describe("the other three", () => {
    it("knows a service talking about people", () => {
        for (const from of [
            "notify@facebookmail.com",
            "noreply@linkedin.com",
            "info@mail.notifications.instagram.com",
            "no-reply@discord.com"
        ]) {
            expect(categoriseMail(message({ subject: "Somebody replied", fromAddress: from })), from).toBe(
                "social"
            );
        }
    });

    it("does not mistake a domain that merely ends in one", () => {
        // `notfacebook.com` is not Facebook, and a suffix match without the dot
        // would say it was.
        expect(
            categoriseMail(message({ subject: "hola", fromAddress: "a@notfacebook.com" }))
        ).toBe("primary");
    });

    it("knows somebody selling something", () => {
        expect(
            categoriseMail(
                message({
                    subject: "Ahorra 100 € en tu verano mediterráneo",
                    fromAddress: "news@lastminute.com",
                    headers: { "list-unsubscribe": "<https://lastminute.com/out>" }
                })
            )
        ).toBe("promotions");
    });

    it("knows a transaction from an offer", () => {
        expect(
            categoriseMail(
                message({
                    subject: "Entregado: Nuki Door Sensor",
                    fromAddress: "envio@amazon.es",
                    headers: { "list-unsubscribe": "<https://amazon.es/out>" }
                })
            )
        ).toBe("updates");
    });

    it("files bulk mail that says nothing either way as an update", () => {
        // A receipt misfiled under Promotions is worse than an offer misfiled
        // under Updates: one is lost, the other is merely in the wrong place.
        expect(
            categoriseMail(
                message({
                    subject: "A note from us",
                    fromAddress: "hello@example.com",
                    headers: { "list-id": "<news.example.com>" }
                })
            )
        ).toBe("updates");
    });
});

describe("what is left", () => {
    it("is a person writing", () => {
        expect(
            categoriseMail(
                message({
                    subject: "Mi Huella",
                    snippet: "Tal y como nos comenta Albert, reenviamos el email de nuevo",
                    fromAddress: "maria@example.com",
                    fromName: "María Aperador"
                })
            )
        ).toBe("primary");
    });

    it("is where anything unrecognised lands", () => {
        // Deliberate. A promotion in the main list is an annoyance; a colleague
        // behind a tab nobody opens is the feature doing harm.
        expect(categoriseMail(message({ subject: "???", fromAddress: "x@y.example" }))).toBe("primary");
        expect(categoriseMail(message())).toBe("primary");
    });
});
