import { describe, expect, it } from "vitest";
import { subjectSignals, urlSignals, type JudgeableMessage } from "./mailbox-spam";

/**
 * What a subject line gives away, and what it does not.
 *
 * These signals came from real messages that reached a real inbox, and the
 * examples below are those messages. That matters more here than anywhere else
 * in the filter: a subject is free text a stranger chose, so it is the easiest
 * place to write a rule that catches every phishing attempt and half of
 * somebody's actual mail along with it.
 *
 * So the tests come in pairs. Each thing the filter reacts to is written twice -
 * once as the message that should raise it, and once as an ordinary message that
 * happens to look similar - and the second half is the half worth keeping. A
 * build server's `[BUILD FAILED]`, a receipt naming an account, a shop's
 * newsletter with a sun in the subject: all of them survive.
 */
describe("what a subject line gives away", () => {
    const message = (subject: string, over: Partial<JudgeableMessage> = {}): JudgeableMessage => ({
        subject,
        snippet: "",
        bodyText: "",
        bodyHtml: "",
        fromAddress: "someone@example.com",
        fromName: "Someone",
        replyToAddress: "",
        toAddresses: ["me@example.com"],
        listId: "",
        headers: "",
        hasAttachments: false,
        attachmentNames: [],
        ...over
    });

    /** Every signal id one subject raises. */
    const raised = (subject: string): string[] =>
        subjectSignals(message(subject)).map((signal) => signal.id);

    /** What those signals add up to. */
    const total = (subject: string): number =>
        subjectSignals(message(subject)).reduce((sum, signal) => sum + signal.score, 0);

    describe("the messages this was written for", () => {
        it("reads the domain-compliance phish", () => {
            // Real, and a good example of the shape: an alert bell, a
            // manufactured deadline, and the reader's own address in the subject
            // to make a template look personal.
            const ids = raised(
                "🔔 Action Required: Verify 'fjrg2007@tpeoficial.com' for ICANN Domain Compliance"
            );
            expect(ids).toContain("subject_alarm_mark");
            expect(ids).toContain("subject_urgency");
            expect(ids).toContain("subject_address");
        });

        it("reads the prize mailing", () => {
            const ids = raised("💎 [24H ONLY] Mega AFKSPIN Jackpot: $7,389.85 + 250 Spins 🎰");
            expect(ids).toContain("subject_pictures");
            expect(ids).toContain("subject_bracket_shout");
            expect(ids).toContain("subject_urgency");
            expect(ids).toContain("subject_money");
        });

        it("reads the delivery phish", () => {
            expect(raised("Delivery attempt failed, we need your confirmation")).toContain(
                "subject_urgency"
            );
        });
    });

    describe("and the mail it must not touch", () => {
        it.each([
            "Your receipt from Apple",
            "[BUILD FAILED] main #4821",
            "[polaris] New pull request opened",
            "Re: lunch on Thursday",
            "☀ This week at the garden centre",
            "Invoice 2026-114 attached",
            "Your Polaris account: sign-in from a new device"
        ])("says nothing about %s", (subject) => {
            // Below the warning threshold on the subject alone. Some of these
            // raise a signal - a bracket, a picture - and that is fine: one
            // signal is a few points, and a few points is not an accusation.
            expect(total(subject)).toBeLessThan(20);
        });

        it("does not treat an ordinary bracketed tag as shouting", () => {
            // Mailing lists, ticket systems and build servers all bracket their
            // name. Only a bracket whose contents are shouting counts.
            expect(raised("[polaris] Weekly digest")).not.toContain("subject_bracket_shout");
            expect(raised("[URGENT] Server down")).toContain("subject_bracket_shout");
        });

        it("keeps a receipt that names the account it belongs to", () => {
            // The address signal on its own is 14, which is a nudge and not a
            // verdict - a receipt naming your address is normal, and the filter
            // has to survive that being true.
            expect(total("Your subscription for me@example.com renews on the 3rd")).toBeLessThan(
                20
            );
        });
    });

    describe("how far a subject alone may go", () => {
        it("can ask for a warning and can never file a message away", () => {
            // The ceiling that matters. A subject is the least reliable thing in
            // a message, so every signal in it together must stay under the
            // score that moves mail out of an inbox - a person can disagree with
            // a warning, and cannot disagree with a message they never saw.
            const worst = "⚠ [ACT NOW] Action Required: verify me@example.com for $9,999.00 🎰";
            expect(total(worst)).toBeGreaterThanOrEqual(40);
            expect(total(worst)).toBeLessThan(70);
        });
    });
});

describe("a link into a part of a site meant for machines", () => {
    const withLink = (href: string): JudgeableMessage => ({
        subject: "Hello",
        snippet: "",
        bodyText: "",
        bodyHtml: `<a href="${href}">Open</a>`,
        fromAddress: "someone@example.com",
        fromName: "Someone",
        replyToAddress: "",
        toAddresses: ["me@example.com"],
        listId: "",
        headers: "",
        hasAttachments: false,
        attachmentNames: []
    });

    it("is raised by a .well-known link, whatever is under it", () => {
        // `.well-known` is where a server proves it owns a certificate and says
        // who to report a vulnerability to. Nobody has ever had a reason to send
        // a person a link into it; what puts one in an email is a phishing kit
        // dropped on somebody else's badly configured server.
        for (const href of [
            "https://example.com/.well-known/css/login.html",
            "https://example.com/.well-known/pki/index.php",
            "http://example.com/.well-known/acme-challenge/x"
        ]) {
            expect(urlSignals(withLink(href)).map((s) => s.id), href).toContain("url_well_known");
        }
    });

    it("is not raised by an ordinary link", () => {
        for (const href of [
            "https://example.com/login",
            "https://example.com/well-known/page",
            "https://example.com/blog/.well-known-secrets"
        ]) {
            expect(urlSignals(withLink(href)).map((s) => s.id), href).not.toContain(
                "url_well_known"
            );
        }
    });
});
