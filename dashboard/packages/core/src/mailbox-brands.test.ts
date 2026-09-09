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
        expect(claim({ subject: "A quick review of your account", fromName: "Netflix" })?.brand.id).toBe(
            "netflix"
        );
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
