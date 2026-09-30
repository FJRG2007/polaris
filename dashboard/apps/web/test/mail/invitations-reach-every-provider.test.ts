/**
 * A calendar invitation goes out through whichever provider the channel uses.
 *
 * Each provider takes the event its own way - nodemailer's icalEvent, an
 * attachment on the three JSON APIs, a raw MIME message on SES - and a provider
 * that dropped it would still report the send as a success, with the guest
 * receiving a message that says "you are invited" and nothing to accept. So each
 * one is pinned here: the .ics arrives, named invite.ics, with its METHOD
 * wherever the provider lets one be stated. A message without an invitation
 * must go out exactly as it did before invitations existed.
 */

import { createHash } from "node:crypto";
import type { MailAccount } from "@/lib/mail/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<Record<string, unknown>> = [];

vi.mock("nodemailer", () => ({
    createTransport: () => ({
        sendMail: async (options: Record<string, unknown>) => {
            sent.push(options);
            return { accepted: [options.to], rejected: [] };
        },
        close: () => undefined
    })
}));

const { sendEmail } = await import("@/lib/mail/send");

const ICS = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Polaris//Calendar//EN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    "UID:fixture-event@example.test",
    "DTSTAMP:20260930T090000Z",
    "DTSTART:20261001T090000Z",
    "SUMMARY:Planificación semanal",
    "END:VEVENT",
    "END:VCALENDAR",
    ""
].join("\r\n");

const PLAIN = { to: "guest@example.test", subject: "Weekly planning", text: "See you there.", html: "<p>See you there.</p>" };
const INVITE = { ...PLAIN, calendar: { method: "REQUEST" as const, ics: ICS } };
const CONTENT_TYPE = "text/calendar; charset=utf-8; method=REQUEST";

const requests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];

beforeEach(() => {
    sent.length = 0;
    requests.length = 0;
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string>; body: string }) => {
        requests.push({ url, headers: init.headers, body: init.body });
        const payload = url.includes("mailjet") ? { Messages: [{ Status: "success" }] } : {};
        return new Response(JSON.stringify(payload), { status: 200 });
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const lastBody = () => JSON.parse(requests[requests.length - 1].body) as Record<string, unknown>;

const ACCOUNTS = {
    smtp: {
        config: { provider: "smtp", settings: { host: "smtp.example.test", port: 587, user: "u", from: "cal@example.test" } },
        secret: "fixture-secret"
    },
    resend: { config: { provider: "resend", settings: { from: "cal@example.test" } }, secret: "fixture-secret" },
    brevo: { config: { provider: "brevo", settings: { from: "cal@example.test" } }, secret: "fixture-secret" },
    mailjet: {
        config: { provider: "mailjet", settings: { apiKey: "fixture-key", from: "cal@example.test" } },
        secret: "fixture-secret"
    },
    ses: {
        config: {
            provider: "ses",
            settings: { accessKeyId: "FIXTUREKEY", region: "eu-west-1", from: "cal@example.test", fromName: "Calendario Ñandú" }
        },
        secret: "fixture-secret"
    }
} satisfies Record<string, MailAccount>;

describe("SMTP", () => {
    it("hands nodemailer the event with its method and file name", async () => {
        await sendEmail(ACCOUNTS.smtp, INVITE);
        expect(sent[0].icalEvent).toEqual({ method: "REQUEST", content: ICS, filename: "invite.ics" });
    });

    it("sends a plain message as before", async () => {
        await sendEmail(ACCOUNTS.smtp, PLAIN);
        expect(sent[0]).toEqual({
            from: "cal@example.test",
            to: PLAIN.to,
            subject: PLAIN.subject,
            text: PLAIN.text,
            html: PLAIN.html
        });
    });
});

describe("Resend", () => {
    it("attaches the event with its method in the content type", async () => {
        await sendEmail(ACCOUNTS.resend, INVITE);
        expect(lastBody().attachments).toEqual([
            { filename: "invite.ics", content: base64(ICS), content_type: CONTENT_TYPE }
        ]);
    });

    it("sends a plain message as before", async () => {
        await sendEmail(ACCOUNTS.resend, PLAIN);
        expect(lastBody()).toEqual({
            from: "cal@example.test",
            to: [PLAIN.to],
            subject: PLAIN.subject,
            text: PLAIN.text,
            html: PLAIN.html
        });
    });
});

describe("Brevo", () => {
    it("attaches the event as invite.ics", async () => {
        await sendEmail(ACCOUNTS.brevo, INVITE);
        expect(lastBody().attachment).toEqual([{ name: "invite.ics", content: base64(ICS) }]);
    });

    it("sends a plain message as before", async () => {
        await sendEmail(ACCOUNTS.brevo, PLAIN);
        expect(lastBody()).toEqual({
            sender: { email: "cal@example.test" },
            to: [{ email: PLAIN.to }],
            subject: PLAIN.subject,
            textContent: PLAIN.text,
            htmlContent: PLAIN.html
        });
    });
});

describe("Mailjet", () => {
    it("attaches the event with its method in the content type", async () => {
        await sendEmail(ACCOUNTS.mailjet, INVITE);
        const [message] = lastBody().Messages as Array<Record<string, unknown>>;
        expect(message.Attachments).toEqual([
            { ContentType: CONTENT_TYPE, Filename: "invite.ics", Base64Content: base64(ICS) }
        ]);
    });

    it("sends a plain message as before", async () => {
        await sendEmail(ACCOUNTS.mailjet, PLAIN);
        expect(lastBody()).toEqual({
            Messages: [
                {
                    From: { Email: "cal@example.test" },
                    To: [{ Email: PLAIN.to }],
                    Subject: PLAIN.subject,
                    TextPart: PLAIN.text,
                    HTMLPart: PLAIN.html
                }
            ]
        });
    });
});

/** A MIME body's parts under a boundary, each split into headers and body. */
function parts(source: string, boundary: string): Array<{ headers: string; body: string }> {
    const [, ...rest] = source.split(`--${boundary}\r\n`);
    return rest.map((chunk) => {
        const content = chunk.split(`\r\n--${boundary}--`)[0].replace(/\r\n$/, "");
        const split = content.indexOf("\r\n\r\n");
        return { headers: content.slice(0, split), body: content.slice(split + 4) };
    });
}

const decode = (body: string) => Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
const boundaryOf = (headers: string) => /boundary="([^"]+)"/.exec(headers)![1];

describe("SES", () => {
    it("sends an invitation as a signed raw message with the event as a text/calendar alternative", async () => {
        await sendEmail(ACCOUNTS.ses, { ...INVITE, subject: "Planificación semanal" });
        const request = requests[0];
        expect(request.url).toBe("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
        expect(request.headers["x-amz-content-sha256"]).toBe(createHash("sha256").update(request.body).digest("hex"));
        expect(request.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=FIXTUREKEY\//);

        const body = JSON.parse(request.body) as { Content: { Raw?: { Data: string }; Simple?: unknown } };
        expect(body.Content.Simple).toBeUndefined();
        const raw = Buffer.from(body.Content.Raw!.Data, "base64").toString("utf8");
        // Every line ends in CRLF, and none is longer than SES accepts.
        expect(raw.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
        expect(Math.max(...raw.split("\r\n").map((line) => line.length))).toBeLessThanOrEqual(998);

        const split = raw.indexOf("\r\n\r\n");
        const headers = raw.slice(0, split);
        expect(headers).toContain("To: guest@example.test");
        expect(headers).toContain("MIME-Version: 1.0");
        expect(headers).toContain(`Subject: =?UTF-8?B?${base64("Planificación semanal")}?=`);
        expect(headers).toContain(`From: =?UTF-8?B?${base64("Calendario Ñandú")}?= <cal@example.test>`);
        expect(headers).toMatch(/Content-Type: multipart\/mixed; boundary="/);

        const [alternative, attachment] = parts(raw.slice(split + 4), boundaryOf(headers));
        expect(alternative.headers).toMatch(/^Content-Type: multipart\/alternative; boundary="/);
        const [text, html, calendar] = parts(alternative.body, boundaryOf(alternative.headers));
        expect(text.headers).toContain("Content-Type: text/plain; charset=utf-8");
        expect(decode(text.body)).toBe(PLAIN.text);
        expect(html.headers).toContain("Content-Type: text/html; charset=utf-8");
        expect(decode(html.body)).toBe(PLAIN.html);
        expect(calendar.headers).toContain(`Content-Type: ${CONTENT_TYPE}`);
        expect(calendar.headers).toContain("Content-Transfer-Encoding: base64");
        expect(decode(calendar.body)).toBe(ICS);

        expect(attachment.headers).toContain('Content-Disposition: attachment; filename="invite.ics"');
        expect(decode(attachment.body)).toBe(ICS);
    });

    it("folds a long non-ASCII subject into encoded words that each decode back", async () => {
        const subject = "Reunión de planificación trimestral con todo el equipo de producto y diseño";
        await sendEmail(ACCOUNTS.ses, { ...INVITE, subject });
        const raw = Buffer.from((lastBody().Content as { Raw: { Data: string } }).Raw.Data, "base64").toString("utf8");
        const header = /\r\nSubject: ((?:.|\r\n )+?)\r\n(?! )/.exec(raw)![1];
        const words = header.split("\r\n ");
        expect(words.length).toBeGreaterThan(1);
        for (const word of words) expect(word.length).toBeLessThanOrEqual(75);
        const decoded = words.map((word) => Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(word)![1], "base64").toString("utf8"));
        expect(decoded.join("")).toBe(subject);
    });

    it("sends a plain message in the simple form, as before", async () => {
        await sendEmail(ACCOUNTS.ses, PLAIN);
        expect(lastBody()).toEqual({
            FromEmailAddress: '"Calendario Ñandú" <cal@example.test>',
            Destination: { ToAddresses: [PLAIN.to] },
            Content: {
                Simple: {
                    Subject: { Data: PLAIN.subject, Charset: "UTF-8" },
                    Body: {
                        Text: { Data: PLAIN.text, Charset: "UTF-8" },
                        Html: { Data: PLAIN.html, Charset: "UTF-8" }
                    }
                }
            }
        });
    });
});
