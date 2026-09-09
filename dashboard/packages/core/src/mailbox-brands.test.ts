/**
 * Mail that says it is somebody it is not.
 *
 * The case that shapes this arrived in a real mailbox and was delivered without
 * a mark on it: a subject reading "Your Net-flix account needs a quick review",
 * a display name of NETFLIX, and a sending domain with nothing to do with
 * either. Nothing in it shouts, so every wording signal the filter had said it
 * was ordinary mail.
 *
 * The other half of what is pinned here is the refusals. A table of famous names
 * is the easiest way there is to junk somebody's real receipt, so: a message
 * FROM the brand is never this, a message that links to the brand is never this,
 * and the names that are also ordinary words - a visa, an apple, the colour
 * orange - do not count on their own.
 */

import * as brands from "./mailbox-brands.js";
import { describe, expect, it } from "vitest";

function claim(
    over: Partial<Parameters<typeof brands.brandClaim>[0]> = {},
    bait = true
): ReturnType<typeof brands.brandClaim> {
    return brands.brandClaim(
        {
            subject: "Your Netflix account needs a quick review",
            fromName: "NETFLIX",
            fromDomain: "mail.some-domain-nobody-has-heard-of.tld",
            linkHosts: ["tracking.some-domain-nobody-has-heard-of.tld"],
            ...over
        },
        bait
    );
}

describe("a name on a message that is not that name's", () => {
    it("is found", () => {
        expect(claim()?.brand.id).toBe("netflix");
    });

    it("is found when the name is written with something inserted into it", () => {
        // The display name goes too, or the plain spelling there would be the
        // one that matched and this would be testing nothing.
        const found = claim({
            subject: "Your Net-flix account needs a quick review",
            fromName: "account services"
        });
        expect(found?.brand.id).toBe("netflix");
        expect(found?.obfuscated).toBe(true);
    });

    it.each([
        ["spaced out", "N e t f l i x billing"],
        ["dotted", "N.E.T.F.L.I.X billing"],
        ["with a digit for a letter", "NETFL1X billing"],
        ["with an accent", "Netflíx billing"]
    ])("sees through a name %s", (_how, subject) => {
        expect(claim({ subject })?.brand.id).toBe("netflix");
    });

    it("says the name was written plainly when it was", () => {
        expect(claim()?.obfuscated).toBe(false);
    });

    it("reads the sender's display name as well as the subject", () => {
        expect(
            claim({ subject: "A quick review of your account", fromName: "Netflix" })?.brand.id
        ).toBe("netflix");
    });
});

describe("a name on a message that IS that name's", () => {
    it("is nothing, when it comes from the brand's own domain", () => {
        expect(claim({ fromDomain: "mailer.netflix.com" })).toBeNull();
    });

    it("is nothing, when the message sends the reader to the brand", () => {
        expect(claim({ linkHosts: ["www.netflix.com"] })).toBeNull();
    });
});

describe("what it refuses to accuse", () => {
    it("does not read a name out of the middle of ordinary words", () => {
        // "much boat" squashed into one string contains "hbo", which is exactly
        // the accident a filter never lives down.
        expect(claim({ subject: "How much boat can we fit", fromName: "Maya" })).toBeNull();
    });

    it("leaves the names that are also ordinary words alone", () => {
        const subject = "The apple orange visa photos";
        expect(claim({ subject, fromName: "Maya" }, false)).toBeNull();
        // And counts them when the message is also asking for an account, which
        // is the pairing that is never innocent.
        expect(claim({ subject, fromName: "Maya" }, true)?.brand.id).toBe("apple");
    });

    it("is nothing at all for a message that names nobody", () => {
        expect(claim({ subject: "Lunch on Thursday", fromName: "Maya Chen" })).toBeNull();
    });
});

describe("every name in the table can actually be found", () => {
    // A name is compiled into the form the comparison happens in, and getting
    // that wrong is silent: `office365` squashes to `officee6s`, so a pattern
    // built from the name as it is typed matched nothing at all and nobody would
    // have known. Each name is asked for by itself here rather than reviewed.
    it.each(
        brands.IMPERSONATED_BRANDS.flatMap((brand) =>
            brand.names.map((name) => [brand.id, name] as const)
        )
    )("finds %s by the name %s", (id, name) => {
        const found = claim({
            subject: `Your ${name} account`,
            fromName: "account services",
            fromDomain: "mail.some-domain-nobody-has-heard-of.tld",
            linkHosts: []
        });
        expect(found?.brand.id).toBe(id);
    });
});

describe("a domain of more than two labels", () => {
    it("is still the brand's own, so its mail is not an impersonation", () => {
        // The last two labels of `amazon.co.uk` are `co.uk`, which belongs to
        // nobody: every UK, and every `.gob.es`, entry in the table was
        // unreachable while that was the rule.
        expect(
            claim({
                subject: "Your Amazon order",
                fromName: "Amazon",
                fromDomain: "mail.amazon.co.uk"
            })
        ).toBeNull();
        expect(
            claim({
                subject: "Your Amazon order",
                fromName: "Amazon",
                fromDomain: "stranger.tld",
                linkHosts: ["www.amazon.co.uk"]
            })
        ).toBeNull();
    });

    it("is the brand's own for an institution under gob.es too", () => {
        expect(
            claim({
                subject: "Notificacion de la Agencia Tributaria",
                fromName: "Agencia Tributaria",
                fromDomain: "correo.agenciatributaria.gob.es"
            })
        ).toBeNull();
    });
});

describe("one of these names writing about another", () => {
    it("is the sender's own mail, not an impersonation of the name it mentions", () => {
        // The table is read in order, so the first name a message mentions used
        // to be the one it was accused of wearing - and PayPal's receipts
        // mention Netflix by design.
        expect(
            claim({
                subject: "You sent a payment to Netflix",
                fromName: "PayPal",
                fromDomain: "service.paypal.com",
                linkHosts: []
            })
        ).toBeNull();
    });
});

describe("a name that is also an ordinary word", () => {
    it("does not hold the brand's other names to the same rule", () => {
        // `hacienda` is a word and `agencia tributaria` is nobody else's, so
        // the weaker rule belongs to the word rather than to the brand.
        expect(
            claim({ subject: "Resumen de la hacienda familiar", fromName: "Maya" }, false)
        ).toBeNull();
        expect(
            claim({ subject: "Notificacion de la Agencia Tributaria", fromName: "Maya" }, false)
                ?.brand.id
        ).toBe("aeat");
    });
});

describe("a name that is two words", () => {
    it("is not called dressed up for being spelled the way it is spelled", () => {
        // The table holds these as one word, so the space between them looked
        // like something inserted - and the reason line went out telling the
        // reader an institution had hyphenated its own name.
        const found = claim({ subject: "Notificacion de la Agencia Tributaria", fromName: "Maya" });
        expect(found?.brand.id).toBe("aeat");
        expect(found?.obfuscated).toBe(false);
    });

    it("still reads a name spaced out letter by letter as dressed up", () => {
        expect(claim({ subject: "N e t f l i x billing", fromName: "Maya" })?.obfuscated).toBe(
            true
        );
    });
});

describe("a sender at a free mailbox", () => {
    it("is a person, not the company whose mailboxes they are", () => {
        // The table holds `gmail.com` because Google's own mail comes from it,
        // and anybody at all can have an address there. Reading it as "this is
        // Google" would exonerate the oldest phishing shape there is.
        const found = claim({
            subject: "Your Netflix account needs a quick review",
            fromName: "NETFLIX",
            fromDomain: "gmail.com",
            linkHosts: []
        });
        expect(found?.brand.id).toBe("netflix");
    });
});
