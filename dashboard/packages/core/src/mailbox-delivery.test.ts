/**
 * What is pinned here is the difference between the two mistakes.
 *
 * Reading a 4xx as final loses a message that would have gone on the next try.
 * Reading a 5xx as temporary tells somebody their message is on its way while
 * it is refused five more times. And calling an ordinary message a bounce marks
 * mail that arrived perfectly well as mail that did not - so most of the
 * delivery-report cases here are the refusals: what must NOT be read as a
 * report, and what must not be tied to a message it only looks related to.
 */

import { describe, expect, it } from "vitest";
import * as delivery from "./mailbox-delivery.js";

function report(over: Partial<delivery.MailReportSource> = {}): delivery.MailReportSource {
    return {
        subject: "Undelivered Mail Returned to Sender",
        from: "mailer-daemon@example.net",
        inReplyTo: "",
        references: [],
        autoSubmitted: "auto-replied",
        text: [
            "This is the mail system at host mail.example.net.",
            "",
            "I'm sorry to have to inform you that your message could not",
            "be delivered to one or more recipients.",
            "",
            "Final-Recipient: rfc822; nobody@example.org",
            "Action: failed",
            "Status: 5.1.1",
            "Diagnostic-Code: smtp; 550 5.1.1 <nobody@example.org>: Recipient address rejected: User unknown"
        ].join("\n"),
        ...over
    };
}

describe("how final a refusal was", () => {
    it("reads a 5xx as final", () => {
        const judged = delivery.judgeSendFailure({
            responseCode: 550,
            response: "550 5.1.1 Recipient address rejected: User unknown"
        });
        expect(judged.verdict).toBe("permanent");
        expect(judged.code).toBe(550);
        expect(judged.reason).toContain("User unknown");
    });

    it("reads a 4xx as worth another try", () => {
        expect(delivery.judgeSendFailure({ responseCode: 451, response: "451 try later" }).verdict).toBe(
            "temporary"
        );
    });

    it("treats a connection that never got an answer as temporary", () => {
        for (const code of ["ESOCKET", "ETIMEDOUT", "ECONNECTION"]) {
            expect(delivery.judgeSendFailure({ code }).verdict).toBe("temporary");
        }
    });

    it("treats an envelope the server would not take as final", () => {
        expect(delivery.judgeSendFailure({ code: "EENVELOPE" }).verdict).toBe("permanent");
    });

    it("guesses temporary when it recognises nothing, because that mistake is the cheap one", () => {
        expect(delivery.judgeSendFailure({}).verdict).toBe("temporary");
        expect(delivery.judgeSendFailure({ code: "EWHATEVER" }).verdict).toBe("temporary");
    });

    it("never puts a socket error's own words on the screen, only a server's reply", () => {
        // `message` is where a library writes "getaddrinfo ENOTFOUND
        // smtp.example.net", and that is Polaris' to say in its own words.
        const judged = delivery.judgeSendFailure({ code: "ESOCKET", response: undefined });
        expect(judged.reason).toBe("");
        expect(delivery.sendFailureSentence(judged)).toContain("could not reach");
    });

    it("flattens a reply onto one line and caps it", () => {
        const judged = delivery.judgeSendFailure({
            responseCode: 552,
            response: `552 too large\r\n  see ${"x".repeat(400)}`
        });
        expect(judged.reason).not.toContain("\n");
        expect(judged.reason.length).toBeLessThanOrEqual(240);
    });

    it("says a final refusal is final and a temporary one is not", () => {
        const final = delivery.sendFailureSentence(
            delivery.judgeSendFailure({ responseCode: 550, response: "550 no such user" })
        );
        expect(final).toContain("Not sent.");
        expect(final).toContain("550 no such user");
        expect(final).not.toContain("try again");

        const later = delivery.sendFailureSentence(delivery.judgeSendFailure({ responseCode: 451 }));
        expect(later).toContain("try again");
    });

    it("names the recipients a server took the message for everybody else but", () => {
        expect(delivery.partialSendSentence([])).toBe("");
        expect(delivery.partialSendSentence(["a@example.org"])).toContain("a@example.org");
        const many = delivery.partialSendSentence([
            "a@example.org",
            "b@example.org",
            "c@example.org",
            "d@example.org"
        ]);
        expect(many).toContain("1 more");
    });
});

describe("reading a delivery report", () => {
    it("reads a plain bounce", () => {
        const read = delivery.readDeliveryReport(report());
        expect(read?.kind).toBe("failed");
        expect(read?.recipient).toBe("nobody@example.org");
        expect(read?.status).toBe("5.1.1");
        expect(read?.reason).toContain("User unknown");
    });

    it("tells a delay from a failure", () => {
        const read = delivery.readDeliveryReport(
            report({
                subject: "Delivery Status Notification (Delay)",
                text: "Action: delayed\nStatus: 4.4.1\nFinal-Recipient: rfc822; slow@example.org\nDiagnostic-Code: smtp; 451 4.4.1 connection timed out"
            })
        );
        expect(read?.kind).toBe("delayed");
        expect(delivery.deliveryReportSentence(read!)).toContain("still trying");
    });

    it("refuses a message that only looks like one", () => {
        // A person writing about a bounce.
        expect(
            delivery.readDeliveryReport(
                report({
                    from: "ana@example.org",
                    subject: "Mail delivery failed, did you see?",
                    autoSubmitted: "",
                    text: "Did you get the bounce I forwarded? Nothing came through."
                })
            )
        ).toBeNull();

        // A newsletter from an address that happens to be called bounce@.
        expect(
            delivery.readDeliveryReport(
                report({
                    from: "bounce@example.net",
                    subject: "Your weekly digest",
                    autoSubmitted: "",
                    text: "Here is what happened this week."
                })
            )
        ).toBeNull();
    });

    it("refuses a report body from an ordinary person's address and ordinary subject", () => {
        expect(
            delivery.readDeliveryReport(
                report({ from: "ana@example.org", subject: "Re: lunch", autoSubmitted: "" })
            )
        ).toBeNull();
    });

    it("names the message it is about from the header the reporting server set", () => {
        const read = delivery.readDeliveryReport(report({ inReplyTo: "sent-1@example.com" }));
        expect(read?.aboutMessageId).toBe("sent-1@example.com");
    });

    it("finds the message id in the copy of the original the report carries", () => {
        const read = delivery.readDeliveryReport(
            report({
                text: `${report().text}\n\n--- Original message ---\nFrom: me@example.com\nMessage-ID: <sent-2@example.com>\nSubject: Invoice`
            })
        );
        expect(read?.aboutMessageId).toBe("sent-2@example.com");
    });

    it("names no message rather than choosing between two", () => {
        const read = delivery.readDeliveryReport(
            report({
                text: "Action: failed\nStatus: 5.1.1\nSomething about <one@example.com> and <two@example.com>"
            })
        );
        expect(read?.aboutMessageId).toBe("");
    });

    it("never reports the mail system itself as the recipient", () => {
        const read = delivery.readDeliveryReport(
            report({
                text: "Action: failed\nStatus: 5.2.2\nThe mail system at mailer-daemon@example.net could not deliver to full@example.org"
            })
        );
        expect(read?.recipient).toBe("full@example.org");
    });

    it("knows which addresses are a mail system", () => {
        expect(delivery.isMailDaemon("MAILER-DAEMON@example.net")).toBe(true);
        expect(delivery.isMailDaemon("postmaster@example.net")).toBe(true);
        expect(delivery.isMailDaemon("ana@example.net")).toBe(false);
    });
});
