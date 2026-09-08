/**
 * The junk filter, judged.
 *
 * This is the one classifier in Polaris whose failure loses somebody's mail, so
 * what is pinned here is mostly the refusals: the cases where the filter has
 * every excuse to accuse and must not. A message from somebody you have written
 * to is not junk however loud its subject is; a message with no authentication
 * headers at all is not junk for lacking them; a mailbox that has been taught
 * nothing yet learns nothing from its own emptiness.
 *
 * The accusations are pinned too, but they are the easy half. A filter that
 * catches nothing is disappointing. A filter that eats an invoice is worse than
 * having no filter, because the person stops looking.
 */

import * as spam from "./mailbox-spam.js";
import { describe, expect, it } from "vitest";

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

describe("an ordinary message", () => {
    it("is delivered, and says nothing about itself", () => {
        const judged = spam.judgeSpam(message(), knows());
        expect(judged.verdict).toBe("clean");
        expect(judged.reason).toBe("");
    });

    it("is not accused because its server writes no authentication headers", () => {
        // Plenty of small mail servers write none at all. Reading their absence
        // as a failure would mark most mail from small domains as junk.
        expect(spam.authenticationSignals(null)).toEqual([]);
        expect(spam.authenticationSignals({ "authentication-results": "" })).toEqual([]);
    });

    it("is not accused when the checks say nobody knows", () => {
        // "none" and "neutral" mean the domain published no policy, which is not
        // the same as failing one.
        const signals = spam.authenticationSignals({
            "authentication-results": "mx.example.com; spf=none; dkim=neutral; dmarc=none"
        });
        expect(signals).toEqual([]);
    });
});

describe("who the mailbox knows", () => {
    it("keeps mail from somebody it has written to, however loud", () => {
        const shouting = message({ subject: "URGENT!!! ACT NOW!!!" });
        const judged = spam.judgeSpam(shouting, knows({ writtenTo: true }));
        expect(judged.verdict).toBe("clean");
    });

    it("counts having written to somebody more heavily than having them saved", () => {
        expect(Math.abs(spam.SPAM_WEIGHTS.relationships.writtenTo)).toBeGreaterThan(
            Math.abs(spam.SPAM_WEIGHTS.relationships.knownContact)
        );
    });

    it("uses one relationship, not both", () => {
        const signals = spam.relationshipSignals(knows({ writtenTo: true, knownContact: true }));
        expect(signals).toHaveLength(1);
        expect(signals[0]?.id).toBe("written_to");
    });

    it("stops at a blocked sender and does not go looking for reasons", () => {
        const judged = spam.judgeSpam(message(), knows({ blocked: true }));
        expect(judged.verdict).toBe("junk");
        expect(judged.signals.map((one) => one.id)).toEqual(["blocked_sender"]);
    });
});

describe("what the sending server said", () => {
    it("treats a DMARC failure as the heaviest single check", () => {
        const signals = spam.authenticationSignals({
            "authentication-results": "mx; spf=fail; dkim=fail; dmarc=fail"
        });
        const dmarc = signals.find((one) => one.id === "dmarc_fail");
        expect(dmarc?.score).toBe(spam.SPAM_WEIGHTS.authentication.dmarcFail);
        expect(dmarc?.score).toBeGreaterThan(
            signals.find((one) => one.id === "dkim_fail")?.score ?? 0
        );
    });

    it("counts a pass in the message's favour", () => {
        const signals = spam.authenticationSignals({
            "authentication-results": "mx; spf=pass; dkim=pass; dmarc=pass"
        });
        expect(signals.every((one) => one.score < 0)).toBe(true);
    });

    it("reads a softfail as a failure", () => {
        const signals = spam.authenticationSignals({ "authentication-results": "mx; spf=softfail" });
        expect(signals[0]?.id).toBe("spf_fail");
    });
});

describe("the links in it", () => {
    it("catches one that says one domain and goes to another", () => {
        const found = spam.urlSignals(
            message({
                bodyHtml: '<a href="https://secure-login.example.ru/pay">https://bank.example.com</a>'
            })
        );
        expect(found.map((one) => one.id)).toContain("url_disguised");
    });

    it("leaves a redirector on the sender's own domain alone", () => {
        // A newsletter linking through its own tracker is exactly this shape,
        // and it is not a disguise.
        const found = spam.urlSignals(
            message({
                fromAddress: "news@example.net",
                bodyHtml: '<a href="https://click.example.net/x">https://shop.example.com</a>'
            })
        );
        expect(found.map((one) => one.id)).not.toContain("url_disguised");
    });

    it("is not fooled by credentials written in front of the host", () => {
        // `https://bank.com@evil.ru/` is served by evil.ru, and reading it as
        // bank.com is the whole trick.
        expect(spam.linkHosts({ bodyHtml: "", bodyText: "https://bank.com@evil.ru/x" })).toEqual([
            "evil.ru"
        ]);
    });

    it("notices a bare address instead of a name", () => {
        const found = spam.urlSignals(message({ bodyText: "http://203.0.113.9/login" }));
        expect(found.map((one) => one.id)).toContain("url_ip_literal");
    });

    it("has nothing to say about a message with no links", () => {
        expect(spam.urlSignals(message())).toEqual([]);
    });
});

describe("the shape of it", () => {
    it("catches a display name posing as a different address", () => {
        const found = spam.structureSignals(
            message({ fromName: "billing@bank.example.com", fromAddress: "x@sender.example.ru" })
        );
        expect(found.map((one) => one.id)).toContain("name_poses_as_address");
    });

    it("leaves a display name that matches its own address alone", () => {
        const found = spam.structureSignals(
            message({ fromName: "maya@example.net", fromAddress: "maya@example.net" })
        );
        expect(found.map((one) => one.id)).not.toContain("name_poses_as_address");
    });

    it("notices replies that would go somewhere else", () => {
        const found = spam.structureSignals(
            message({ fromAddress: "no-reply@example.net", replyToAddress: "collect@other.ru" })
        );
        expect(found.map((one) => one.id)).toContain("reply_elsewhere");
    });

    it("allows a reply-to on the same domain", () => {
        const found = spam.structureSignals(
            message({ fromAddress: "no-reply@example.net", replyToAddress: "help@example.net" })
        );
        expect(found.map((one) => one.id)).not.toContain("reply_elsewhere");
    });

    it("treats a file that would run when opened as the heaviest structural signal", () => {
        const found = spam.structureSignals(
            message({ hasAttachments: true, attachmentNames: ["invoice.pdf.exe"] })
        );
        const executable = found.find((one) => one.id === "attachment_executable");
        expect(executable).toBeDefined();
        expect(executable!.reason).toContain("invoice.pdf.exe");
    });

    it("leaves an ordinary attachment alone", () => {
        const found = spam.structureSignals(
            message({ hasAttachments: true, attachmentNames: ["invoice.pdf"] })
        );
        expect(found.map((one) => one.id)).not.toContain("attachment_executable");
    });
});

describe("what the mailbox has learned about a sender", () => {
    it("says nothing until it has seen enough", () => {
        expect(
            spam.reputationSignal(
                knows({ reputation: [{ kind: "sender", junkCount: 2, goodCount: 0 }] })
            )
        ).toBeNull();
    });

    it("accuses once the record is established", () => {
        const signal = spam.reputationSignal(
            knows({ reputation: [{ kind: "sender", junkCount: 6, goodCount: 0 }] })
        );
        expect(signal?.id).toBe("reputation_junk_sender");
    });

    it("counts a good record in the message's favour", () => {
        const signal = spam.reputationSignal(
            knows({ reputation: [{ kind: "domain", junkCount: 0, goodCount: 8 }] })
        );
        expect(signal?.score).toBeLessThan(0);
    });

    it("uses one record rather than stacking three views of the same sender", () => {
        const signal = spam.reputationSignal(
            knows({
                reputation: [
                    { kind: "sender", junkCount: 6, goodCount: 0 },
                    { kind: "domain", junkCount: 9, goodCount: 0 },
                    { kind: "fingerprint", junkCount: 5, goodCount: 0 }
                ]
            })
        );
        expect(signal?.score).toBe(spam.SPAM_WEIGHTS.reputation.establishedJunk);
    });
});

describe("what it has learned from words", () => {
    const counts = new Map<string, spam.TokenCounts>([
        ["viagra", { token: "viagra", junkCount: 30, goodCount: 0 }],
        ["invoice", { token: "invoice", junkCount: 0, goodCount: 30 }]
    ]);

    it("stays silent on a mailbox that has been taught nothing", () => {
        expect(spam.contentScore(["viagra"], counts, { junkMessages: 0, goodMessages: 0 })).toBe(0);
        expect(spam.contentScore(["viagra"], counts, { junkMessages: 2, goodMessages: 40 })).toBe(0);
    });

    it("can never decide a message on its own", () => {
        const loaded = new Map(counts);
        for (let index = 0; index < 100; index += 1) {
            loaded.set(`bad${index}`, { token: `bad${index}`, junkCount: 30, goodCount: 0 });
        }
        const score = spam.contentScore([...loaded.keys()], loaded, {
            junkMessages: 40,
            goodMessages: 40
        });
        expect(score).toBeLessThanOrEqual(spam.MAX_CONTENT_SCORE);
        expect(score).toBeLessThan(spam.SPAM_THRESHOLDS.junk);
    });

    it("pulls the other way for words that only appear in kept mail", () => {
        expect(
            spam.contentScore(["invoice"], counts, { junkMessages: 40, goodMessages: 40 })
        ).toBeLessThan(0);
    });

    it("weighs one word out of many far less than many", () => {
        const one = spam.contentScore(["viagra"], counts, { junkMessages: 40, goodMessages: 40 });
        const loaded = new Map(counts);
        for (let index = 0; index < 20; index += 1) {
            loaded.set(`bad${index}`, { token: `bad${index}`, junkCount: 30, goodCount: 0 });
        }
        const many = spam.contentScore([...loaded.keys()], loaded, {
            junkMessages: 40,
            goodMessages: 40
        });
        expect(many).toBeGreaterThan(one);
    });

    it("ignores a word it has barely seen", () => {
        const thin = new Map<string, spam.TokenCounts>([
            ["maybe", { token: "maybe", junkCount: 1, goodCount: 0 }]
        ]);
        expect(spam.contentScore(["maybe"], thin, { junkMessages: 40, goodMessages: 40 })).toBe(0);
    });
});

describe("the words a message is learned by", () => {
    it("drops numbers, so an invoice reference is never stored", () => {
        const tokens = spam.tokensOf(message({ subject: "Invoice 998211", bodyText: "12.50" }));
        expect(tokens).toContain("invoice");
        expect(tokens).not.toContain("998211");
        expect(tokens).not.toContain("12.50");
    });

    it("is bounded, so a long message does not outweigh a short one", () => {
        const long = Array.from({ length: 5000 }, (_, index) => `word${index}`).join(" ");
        expect(spam.tokensOf(message({ bodyText: long })).length).toBeLessThanOrEqual(
            spam.MAX_TOKENS_PER_MESSAGE
        );
    });

    it("has each word once, however often it was written", () => {
        const tokens = spam.tokensOf(message({ subject: "", bodyText: "offer offer offer" }));
        expect(tokens.filter((one) => one === "offer")).toHaveLength(1);
    });
});

describe("recognising the same mailing again", () => {
    it("gives two copies of one campaign the same fingerprint", () => {
        const first = message({ fromAddress: "a@one.ru", subject: "Your parcel is waiting" });
        const second = message({ fromAddress: "b@two.ru", subject: "Your parcel is waiting" });
        expect(spam.spamFingerprint(first)).toBe(spam.spamFingerprint(second));
    });

    it("separates two different mailings", () => {
        expect(spam.spamFingerprint(message({ subject: "Your parcel is waiting" }))).not.toBe(
            spam.spamFingerprint(message({ subject: "Board meeting notes for Q3 and beyond" }))
        );
    });
});

describe("the verdict", () => {
    it("holds a message in the middle band rather than filing it", () => {
        // Real evidence, and not enough of it. This is the band the whole design
        // exists for: say so on the message, and leave it where it was.
        const judged = spam.judgeSpam(
            message({
                subject: "ACCOUNT SUSPENDED",
                replyToAddress: "collect@other.ru",
                bodyText: "Confirm at https://bit.ly/x2f",
                headers: { "authentication-results": "mx; spf=softfail; dmarc=fail" }
            }),
            knows()
        );
        expect(judged.score).toBeGreaterThanOrEqual(spam.SPAM_THRESHOLDS.suspicious);
        expect(judged.score).toBeLessThan(spam.SPAM_THRESHOLDS.junk);
        expect(judged.verdict).toBe("suspicious");
    });

    it("takes more than a shouting subject to reach the middle band", () => {
        // The whole reason the weights are shaped the way they are: tone is not
        // evidence. A real message from somebody having a bad day looks like
        // this, and it has to arrive.
        const judged = spam.judgeSpam(message({ subject: "URGENT!!! PLEASE READ" }), knows());
        expect(judged.verdict).toBe("clean");
    });

    it("files one that fails every check", () => {
        const judged = spam.judgeSpam(
            message({
                subject: "URGENT!!! YOUR ACCOUNT",
                fromName: "security@bank.example.com",
                fromAddress: "x@sender.example.ru",
                replyToAddress: "collect@other.ru",
                bodyHtml: '<a href="https://evil.example.ru/p">https://bank.example.com</a>',
                headers: { "authentication-results": "mx; spf=fail; dkim=fail; dmarc=fail" }
            }),
            knows()
        );
        expect(judged.verdict).toBe("junk");
    });

    it("explains itself with the heaviest accusation and never with a compliment", () => {
        const judged = spam.judgeSpam(
            message({
                fromName: "security@bank.example.com",
                fromAddress: "x@sender.example.ru",
                headers: { "authentication-results": "mx; dkim=pass; dmarc=fail" }
            }),
            knows()
        );
        expect(judged.verdict).not.toBe("clean");
        // The impersonation, not the signature that happened to check out.
        expect(judged.reason).toContain("security@bank.example.com");

        // And a message that arrived says nothing about itself at all.
        expect(spam.judgeSpam(message(), knows()).reason).toBe("");
    });

    it("never reports less than nothing or more than everything", () => {
        const kept = spam.judgeSpam(
            message({ headers: { "authentication-results": "mx; spf=pass; dkim=pass; dmarc=pass" } }),
            knows({ writtenTo: true, reputation: [{ kind: "sender", junkCount: 0, goodCount: 30 }] })
        );
        expect(kept.score).toBe(0);
        expect(kept.verdict).toBe("clean");
    });
});
