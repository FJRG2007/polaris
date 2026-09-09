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
import {
    categoriseMail,
    isDisposableSecurityMail,
    type CategorisableMessage
} from "./mailbox-category.js";

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
        // An invoice is a bill rather than a record of one, so it sits with the
        // rest of what is about to be taken - but it is still not a code, which
        // is what this is checking.
        expect(
            categoriseMail(
                message({ subject: "Invoice 4471 is ready", fromAddress: "billing@shop.example" })
            )
        ).toBe("billing");
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
            expect(
                categoriseMail(message({ subject: "Somebody replied", fromAddress: from })),
                from
            ).toBe("social");
        }
    });

    it("does not mistake a domain that merely ends in one", () => {
        // `notfacebook.com` is not Facebook, and a suffix match without the dot
        // would say it was.
        expect(categoriseMail(message({ subject: "hola", fromAddress: "a@notfacebook.com" }))).toBe(
            "primary"
        );
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

describe("money that is about to move", () => {
    it("catches the reminder a payment plan sends before it takes anything", () => {
        // The one that started this: a card sends the dates of the next
        // instalments, days before the first of them leaves the account.
        expect(
            categoriseMail(
                message({
                    subject: "JAVIER, recuerda las fechas de los próximos pagos de tu compra",
                    snippet: "08/26/2026 · 08/27/2026 · 09/03/2026",
                    fromAddress: "noreply@pagos.example"
                })
            )
        ).toBe("billing");
    });

    it("catches a subscription renewing, in the languages a mailbox arrives in", () => {
        const subjects = [
            "Your subscription renews on 3 October",
            "Tu suscripción se renovará automáticamente",
            "Votre abonnement sera renouvelé",
            "Il tuo abbonamento si rinnova",
            "A sua assinatura será renovada"
        ];
        for (const subject of subjects) {
            expect(categoriseMail(message({ subject, fromAddress: "billing@example.com" }))).toBe(
                "billing"
            );
        }
    });

    it("catches a card that is about to fail, which is the one nobody wants to miss", () => {
        expect(
            categoriseMail(
                message({ subject: "Your card is expiring", fromAddress: "no-reply@example.com" })
            )
        ).toBe("billing");
        expect(
            categoriseMail(
                message({
                    subject: "Payment failed for your plan",
                    fromAddress: "no-reply@example.com"
                })
            )
        ).toBe("billing");
        expect(
            categoriseMail(
                message({
                    subject: "Tu prueba gratuita termina mañana",
                    fromAddress: "hi@example.com"
                })
            )
        ).toBe("billing");
    });

    it("takes an invoice, and leaves a receipt where it was", () => {
        // A demand and a record are not the same mail: one is worth reading
        // before the money moves and the other after.
        expect(
            categoriseMail(
                message({ subject: "Invoice 2026-114 is due", fromAddress: "a@b.example" })
            )
        ).toBe("billing");
        expect(
            categoriseMail(
                message({ subject: "Factura de septiembre", fromAddress: "a@b.example" })
            )
        ).toBe("billing");
        expect(
            categoriseMail(
                message({ subject: "Your order has shipped", fromAddress: "shop@example.com" })
            )
        ).toBe("updates");
        expect(
            categoriseMail(
                message({ subject: "Tu pedido va en reparto", fromAddress: "shop@example.com" })
            )
        ).toBe("updates");
    });

    it("wins over the offer wrapped around it", () => {
        // Half of these arrive dressed as a sale - "your plan renews, and here
        // is 20% off the annual one" - and the half that matters is the renewal.
        expect(
            categoriseMail(
                message({
                    subject: "Your plan renews soon - save 20% on annual",
                    fromAddress: "news@example.com",
                    headers: { "list-unsubscribe": "<mailto:no@example.com>" }
                })
            )
        ).toBe("billing");
    });

    it("still leaves a code alone, which expires sooner than any bill", () => {
        expect(
            categoriseMail(
                message({
                    subject: "Your verification code for your subscription",
                    fromAddress: "no-reply@example.com"
                })
            )
        ).toBe("security");
    });
    it("knows a trial about to bill, whoever is sending it", () => {
        // Stripe sends these on behalf of whoever is charging, so the sender says
        // nothing and the subject is all there is. The pattern is the tense: this
        // has not happened yet, and it is the last chance to stop it.
        expect(
            categoriseMail(
                message({
                    subject: "Your Osintly trial ends soon",
                    snippet:
                        "Your free trial for Pro with Osintly will end soon. You have an upcoming payment on September 9, 2026.",
                    fromAddress: "trial-ending+acct_1tevifdlwma5blqj@stripe.com",
                    headers: { "list-unsubscribe": "<https://example.invalid/u>" }
                })
            )
        ).toBe("billing");
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
        expect(categoriseMail(message({ subject: "???", fromAddress: "x@y.example" }))).toBe(
            "primary"
        );
        expect(categoriseMail(message())).toBe("primary");
    });
});

describe("mail about the safety of an account", () => {
    const message = (subject: string, snippet = "") => ({
        subject,
        snippet,
        fromAddress: "noreply@github.com",
        fromName: "GitHub",
        headers: null
    });

    it("lands under Security, not under Updates", () => {
        // The one that was reported: a secret-scanning alert read as ordinary
        // transactional mail and sat with the receipts.
        expect(categoriseMail(message("Action needed: Secrets detected in FJRG2007/rook"))).toBe(
            "security"
        );
        expect(categoriseMail(message("Security alert: unusual sign-in"))).toBe("security");
        expect(categoriseMail(message("Your account has been locked"))).toBe("security");
    });

    it("is read from the line under the subject too", () => {
        // "Action needed" says nothing on its own. What it is about is in the
        // snippet, which is where these are always written.
        expect(
            categoriseMail(
                message("Action needed", "Anyone with read access can view exposed secrets.")
            )
        ).toBe("security");
    });

    it("knows an account change said as news rather than as a warning", () => {
        // The commonest security mail there is, and the one that used to land in
        // Primary: nothing in it is worded as an alert. "Password Changed" is the
        // whole subject, and if it was not you, it is the most urgent mail of the
        // year.
        for (const subject of [
            "Rockstar Games Password Changed",
            "Your password has been updated",
            "We have changed your password",
            "Your recovery email was changed",
            "New sign-in from Madrid",
            "Tu contrasena ha sido actualizada",
            "Cambio de contraseña en tu cuenta",
            "Sua senha foi alterada",
            "Votre mot de passe a été modifié",
            "Ihr Passwort wurde geändert",
            "La tua password è stata modificata"
        ]) {
            expect(categoriseMail(message(subject)), subject).toBe("security");
        }
    });

    it("never sweeps one of those, because it is the record", () => {
        // A code expires; the notice that somebody changed your password is the
        // evidence, and it has to still be there in a month.
        expect(isDisposableSecurityMail(message("Rockstar Games Password Changed"))).toBe(false);
        expect(isDisposableSecurityMail(message("Your password has been updated"))).toBe(false);
    });

    it("is never swept, however old it gets", () => {
        // The whole reason the two halves are told apart: a code is worthless
        // within the hour, and this is the most important mail of somebody's
        // week.
        expect(
            isDisposableSecurityMail(message("Action needed: Secrets detected in FJRG2007/rook"))
        ).toBe(false);
        expect(isDisposableSecurityMail(message("Security alert: unusual sign-in"))).toBe(false);
    });

    it("still sweeps a code, which is what the clear-up is for", () => {
        expect(isDisposableSecurityMail(message("Your verification code is 402913"))).toBe(true);
        expect(isDisposableSecurityMail(message("Tu codigo de verificacion"))).toBe(true);
    });

    it("keeps a code that also carries an alert word", () => {
        // A message saying both is the dangerous one to guess at, so the answer
        // is the cautious one: it stays.
        expect(
            isDisposableSecurityMail(
                message("Your verification code", "We noticed suspicious activity on your account.")
            )
        ).toBe(false);
    });

    it("has nothing to say about ordinary mail", () => {
        expect(isDisposableSecurityMail(message("Lunch on Thursday"))).toBe(false);
    });
});

/**
 * The receipt, and why it was not being recognised.
 *
 * A Steam receipt says `Invoice`, `VAT` and `Total` - in its body, which the
 * categoriser never opens. All it gets is the subject, the snippet, the sender
 * and the headers, and the line anybody actually sees says "Thank you for your
 * recent transaction on Steam". Nothing in that is a billing word, so a purchase
 * landed under Updates beside a parcel and a service notice.
 *
 * The lists are written against what a receipt SAYS, not against who sent it -
 * there is no Steam in here, and adding a shop to Polaris must never mean adding
 * a line to a list.
 */
describe("a purchase, recognised by what it says", () => {
    const seen = (subject: string, snippet: string, from = "noreply@example.com") =>
        categoriseMail(message({ subject, snippet, fromAddress: from }));

    it("files the receipt that arrives with nothing but a thank-you", () => {
        // The real one, from the real address, with the snippet as it arrives.
        expect(
            seen(
                "Thank you for your Steam purchase!",
                "Hello someone Thank you for your recent transaction on Steam. To view the details, please visit https://store.steampowered.com/email/VATPurchaseReceipt",
                "noreply@steampowered.com"
            )
        ).toBe("billing");
    });

    it("files one in every language a receipt arrives in", () => {
        expect(seen("Confirmacion", "Gracias por tu compra")).toBe("billing");
        expect(seen("Recibo", "Pago recibido")).toBe("billing");
        expect(seen("Confirmation", "Merci pour votre commande")).toBe("billing");
        expect(seen("Bestellung", "Zahlung erhalten")).toBe("billing");
    });

    it("still leaves a parcel where a parcel belongs", () => {
        // The one place the two lists overlap, and the commonest word in both:
        // "your order" opens a receipt and a shipping notice alike.
        expect(seen("Your order has shipped", "It is on its way")).toBe("updates");
        expect(seen("Tu pedido va en reparto", "Llega hoy")).toBe("updates");
        expect(seen("Your parcel is out for delivery", "")).toBe("updates");
    });

    it("keeps a demand ahead of a record", () => {
        // A bill that has not been paid is still the more urgent of the two, and
        // it wins even when the message also reads like a receipt.
        expect(seen("Invoice 2026-114 is due", "Payment received for the previous one")).toBe(
            "billing"
        );
    });

    it("leaves a campaign that mentions one where a campaign belongs", () => {
        // Splitting the receipt words out of the transactional pile must not
        // move bulk mail that is plainly selling something: an offer on tickets
        // is an offer, and a sale that thanks you for a past purchase on its way
        // to the discount is still a sale.
        const bulk = (subject: string, snippet: string) =>
            categoriseMail(
                message({
                    subject,
                    snippet,
                    fromAddress: "news@shop.example",
                    headers: { "list-unsubscribe": "<https://shop.example/out>" }
                })
            );
        expect(bulk("Save 30% on your next ticket", "Book now, offer ends Sunday")).toBe(
            "promotions"
        );
        expect(bulk("20% off, just for you", "Thank you for your purchase last month")).toBe(
            "promotions"
        );
    });
});

describe("a lender's payment confirmation", () => {
    it("is money, not an update", () => {
        // "Paga en 4" is a lender's instalment plan, and this is the message
        // that says a payment went through. It arrived under Updates, beside a
        // parcel, which is the tab for what is about to happen rather than for
        // what already cost something.
        expect(
            categoriseMail({
                subject: "Tu pago con Paga en 4 en AMAZON ha sido aceptado",
                snippet: "Tu pago con Paga en 4 en AMAZON ha sido aceptado. Importe 39,99 EUR",
                fromAddress: "noreply@cofidis.es",
                fromName: "noreply",
                headers: {}
            })
        ).toBe("billing");
    });
});
