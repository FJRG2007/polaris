/**
 * The message that got through, and the mail that must not be filed beside it.
 *
 * A phishing message reached an inbox that other clients catch: a meeting tool's
 * name on the front of it, a cousin of the tool's real domain behind it, a
 * subject that pushes, a footer claiming to be a mailing list with no way out
 * published, and a row of Privacy and Terms links that go nowhere. Every one of
 * those was readable on the row as it arrived and none of them was being read.
 *
 * So this file is the pair. One message that has to reach Junk, and four that
 * have to reach the inbox - a stranger writing for the first time, a newsletter
 * somebody signed up to, the tool's own mail, and a real company writing from a
 * domain the table has never heard of. The refusals are the half worth having:
 * a filter that catches nothing is disappointing, and one that eats a first
 * message from a new client is worse than having no filter at all.
 */

import * as spam from "./mailbox-spam.js";
import { describe, expect, it } from "vitest";
import { lookalikeBrand } from "./mailbox-brands.js";

function message(over: Partial<spam.JudgeableMessage> = {}): spam.JudgeableMessage {
    return {
        subject: "Lunch on Thursday",
        fromAddress: "maya@example.net",
        fromName: "Maya Chen",
        replyToAddress: "",
        toAddresses: ["me@example.com"],
        snippet: "Are you free around one",
        bodyText: "Are you free around one",
        bodyHtml: "",
        listId: "",
        hasAttachments: false,
        attachmentNames: [],
        headers: null,
        ...over
    };
}

function knows(over: Partial<spam.SpamKnowledge> = {}): spam.SpamKnowledge {
    return {
        knownContact: false,
        writtenTo: false,
        blocked: false,
        reputation: [],
        contentScore: 0,
        ...over
    };
}

/** A real footer: the words, and the pages behind them. */
const REAL_FOOTER = [
    '<a href="https://news.example.com/privacy">Privacy Policy</a>',
    '<a href="https://news.example.com/terms">Terms of Service</a>',
    '<a href="https://news.example.com/help">Help Center</a>',
    '<a href="https://news.example.com/unsubscribe?id=9">Unsubscribe</a>'
].join(" ");

/** The same words with nothing behind them. */
const DEAD_FOOTER = [
    '<a href="#">Privacy Policy</a>',
    '<a href="">Terms of Service</a>',
    '<a href="javascript:void(0)">Help Center</a>'
].join(" ");

/**
 * The one that arrived, near enough word for word.
 *
 * Written with fixture addresses throughout except the two that are the whole
 * point: the name it wore, and the cousin domain it wore it from.
 */
const phish = message({
    subject: "URGENT INVITATION: Your Q4 Zoom Cloud Meeting Project Review",
    fromName: "ZOOM RECORDING",
    fromAddress: "recordings.zoom@zoom.net",
    toAddresses: ["me@example.com"],
    snippet: "Your cloud recording of the Q4 project review is ready to view",
    bodyText: [
        "Your cloud recording of the Q4 project review is ready to view.",
        "View recording",
        "ZOOM RECORDING sends this as a mailing list.",
        "Privacy Policy Terms of Service Help Center Unsubscribe"
    ].join("\n"),
    bodyHtml: [
        "<p>Your cloud recording of the Q4 project review is ready to view.</p>",
        '<a href="https://secure-zoom-portal.example/view">View recording</a>',
        "<p>ZOOM RECORDING sends this as a mailing list.</p>",
        DEAD_FOOTER,
        '<a href="#">Unsubscribe</a>'
    ].join("")
});

describe("the message that got through", () => {
    it("is filed as junk", () => {
        const judged = spam.judgeSpam(phish, knows());
        expect(judged.verdict).toBe("junk");
    });

    it("is filed on several separate things being wrong, not on one", () => {
        // Worth pinning because the weights are deliberately modest: no single
        // one of these reaches the line, and the filter is only right about this
        // message because it read all of them.
        const fired = spam.judgeSpam(phish, knows()).signals.map((one) => one.id);
        expect(fired).toContain("brand_impersonation");
        expect(fired).toContain("lookalike_domain");
        expect(fired).toContain("stranger_pressure");
        expect(fired).toContain("list_without_unsubscribe");
        expect(fired).toContain("footer_links_nowhere");
    });

    it("says why, in sentences about the message rather than about the filter", () => {
        const judged = spam.judgeSpam(phish, knows());
        expect(judged.reason).toContain("Zoom");
        expect(judged.reasons.length).toBeGreaterThan(1);
        expect(judged.reasons[0]).toBe(judged.reason);
        // Never a compliment, and never a number.
        expect(judged.reasons.join(" ")).not.toMatch(/\bscore\b|\b\d{2,3} out of\b/i);
    });

    it("is still junk when somebody's server wrote no authentication headers", () => {
        // The message arrived with none. Reading their absence as a failure is
        // what the filter must not do, and this one is caught without it.
        expect(phish.headers).toBeNull();
        expect(spam.judgeSpam(phish, knows()).verdict).toBe("junk");
    });

    it("is not junk from somebody this mailbox writes to", () => {
        // The refusal that matters most. Everything above is evidence, and
        // evidence loses to a correspondent.
        expect(spam.judgeSpam(phish, knows({ writtenTo: true })).verdict).not.toBe("junk");
    });
});

describe("a first message from a real person", () => {
    const stranger = message({
        subject: "Following up on the quote",
        fromName: "Ana Ruiz",
        fromAddress: "ana@ruiz-consulting.example",
        snippet: "Hi, we spoke at the fair last week about the March delivery",
        bodyText: "Hi, we spoke at the fair last week about the March delivery.",
        bodyHtml: "<p>Hi, we spoke at the fair last week about the March delivery.</p>"
    });

    it("arrives, and says nothing about itself", () => {
        const judged = spam.judgeSpam(stranger, knows());
        expect(judged.verdict).toBe("clean");
        expect(judged.reason).toBe("");
        expect(judged.reasons).toEqual([]);
    });

    it("arrives even when their server vouches for nothing at all", () => {
        // Plenty of small mail servers publish no policy. A first message from
        // one is a first message, not a forgery.
        const judged = spam.judgeSpam(
            message({
                ...stranger,
                headers: { "authentication-results": "mx.example.com; spf=none; dmarc=none" }
            }),
            knows()
        );
        expect(judged.verdict).toBe("clean");
    });

    it("arrives when they are having a bad day about it", () => {
        // A pressing word is a tone, and tone is not evidence. On its own it
        // cannot even reach the band that shows a warning.
        const judged = spam.judgeSpam(
            message({ ...stranger, subject: "Urgent: the March delivery" }),
            knows()
        );
        expect(judged.verdict).toBe("clean");
    });
});

describe("a mailing somebody signed up to", () => {
    const newsletter = message({
        subject: "This week at the studio",
        fromName: "The Studio",
        fromAddress: "hello@studio.example",
        snippet: "Three things we shipped, and one we did not",
        bodyText: "Three things we shipped, and one we did not. Unsubscribe.",
        bodyHtml: `<p>Three things we shipped, and one we did not.</p>${REAL_FOOTER}`,
        listId: "studio.studio.example",
        headers: {
            "list-id": "<studio.studio.example>",
            "list-unsubscribe": "<https://news.example.com/unsubscribe?id=9>",
            "authentication-results": "mx; spf=pass; dkim=pass; dmarc=pass"
        }
    });

    it("arrives, footer and all", () => {
        const judged = spam.judgeSpam(newsletter, knows());
        expect(judged.verdict).toBe("clean");
        expect(judged.signals.map((one) => one.id)).not.toContain("footer_links_nowhere");
        expect(judged.signals.map((one) => one.id)).not.toContain("list_without_unsubscribe");
    });

    it("is not accused for the one link in it that is a fragment", () => {
        // A "back to top" is what fragments are for, and half the mailings in
        // the world carry one. Only the row of boilerplate links is read.
        const judged = spam.judgeSpam(
            message({
                ...newsletter,
                bodyHtml: `<a href="#top">Back to top</a>${REAL_FOOTER}`
            }),
            knows()
        );
        expect(judged.signals.map((one) => one.id)).not.toContain("footer_links_nowhere");
    });

    it("is accused when every one of those links is the same page", () => {
        // Different words, one destination: there is only one page, and it is
        // the one after the reader's password.
        const signals = spam.footerSignals(
            message({
                bodyHtml: [
                    '<a href="https://collect.example/x">Privacy Policy</a>',
                    '<a href="https://collect.example/x">Terms of Service</a>',
                    '<a href="https://collect.example/x">Unsubscribe</a>'
                ].join(" ")
            })
        );
        expect(signals.map((one) => one.id)).toEqual(["footer_links_identical"]);
    });

    it("follows nothing and fetches nothing to decide it", () => {
        // The body is a stranger's markup. It is read as text, and an address in
        // it is never requested - the signal is about what the markup says, and
        // asking would be the server visiting a link somebody else chose.
        expect(spam.footerSignals.toString()).not.toMatch(/fetch|http\.|request\(/);
    });
});

describe("a domain wearing a name that is not its own", () => {
    it("reads zoom.net as a cousin of the real one", () => {
        expect(lookalikeBrand({ fromDomain: "zoom.net", linkHosts: [] })?.id).toBe("zoom");
        expect(lookalikeBrand({ fromDomain: "paypal-billing.example", linkHosts: [] })?.id).toBe(
            "paypal"
        );
    });

    it("leaves the real ones alone", () => {
        expect(lookalikeBrand({ fromDomain: "zoom.us", linkHosts: [] })).toBeNull();
        expect(lookalikeBrand({ fromDomain: "mail.zoom.us", linkHosts: [] })).toBeNull();
        expect(lookalikeBrand({ fromDomain: "mailer.netflix.com", linkHosts: [] })).toBeNull();
    });

    it("does not read a longer word as the name inside it", () => {
        // `zoominfo` is a company, not a disguise, and this is the mistake a
        // substring match makes on its first day.
        expect(lookalikeBrand({ fromDomain: "zoominfo.example", linkHosts: [] })).toBeNull();
        expect(lookalikeBrand({ fromDomain: "myamazonstore.example", linkHosts: [] })).toBeNull();
    });

    it("leaves the names that are also ordinary words", () => {
        // A colour, a document and a fruit. A domain with one of them in it is
        // usually about none of the three companies.
        expect(lookalikeBrand({ fromDomain: "orange-juice.example", linkHosts: [] })).toBeNull();
        expect(lookalikeBrand({ fromDomain: "visa-help.example", linkHosts: [] })).toBeNull();
    });

    it("leaves a message that sends the reader to the name it wears", () => {
        // The same exemption the display-name check makes: the table of domains
        // is hand-written, and a message that links to the brand is the brand's.
        expect(
            lookalikeBrand({ fromDomain: "clientes-endesa.example", linkHosts: ["www.endesa.es"] })
        ).toBeNull();
    });

    it("never reaches the junk line on the domain alone", () => {
        const judged = spam.judgeSpam(
            message({ fromAddress: "billing@paypal-billing.example", fromName: "Billing" }),
            knows()
        );
        expect(judged.score).toBeLessThan(spam.SPAM_THRESHOLDS.suspicious);
    });
});

describe("what an outside provider is allowed to decide", () => {
    it("files a message on a fraud verdict alone", () => {
        // What the app half hands over when a reputation provider holds the
        // sender on file. It is scored at the junk line exactly, so it is a
        // verdict on its own.
        const judged = spam.judgeSpam(
            message(),
            knows({
                outside: [
                    {
                        id: "address_fraud",
                        score: spam.SPAM_THRESHOLDS.junk,
                        reason: "maya@example.net is known for defrauding people"
                    }
                ]
            })
        );
        expect(judged.verdict).toBe("junk");
    });

    it("loses to a sender this mailbox writes to", () => {
        // Deliberate. The person who corresponds with somebody knows something
        // no provider does, and a wrong fraud verdict must not take their mail.
        const judged = spam.judgeSpam(
            message(),
            knows({
                writtenTo: true,
                outside: [
                    {
                        id: "address_fraud",
                        score: spam.SPAM_THRESHOLDS.junk,
                        reason: "maya@example.net is known for defrauding people"
                    }
                ]
            })
        );
        expect(judged.verdict).not.toBe("junk");
    });

    it("changes nothing when the provider had nothing to say", () => {
        expect(spam.judgeSpam(phish, knows({ outside: [] })).score).toBe(
            spam.judgeSpam(phish, knows()).score
        );
    });
});
