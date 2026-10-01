/**
 * Amazon SES v2 over its HTTPS API, signed with Signature Version 4.
 *
 * Sending one message needs one request, so this signs that request directly
 * rather than pulling in the AWS SDK - which would add several dozen packages to
 * the supply chain to reach a single endpoint. The signing steps below follow
 * the SigV4 specification in order; the comments name each one so the code can
 * be checked against it.
 */

import { formatFrom, type SesConfig } from "@polaris/core";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { calendarContentType, INVITE_FILENAME, type EmailMessage } from "./types";

const SERVICE = "ses";
const ALGORITHM = "AWS4-HMAC-SHA256";
const PATH = "/v2/email/outbound-emails";

function sha256Hex(payload: string): string {
    return createHash("sha256").update(payload, "utf8").digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
    return createHmac("sha256", key).update(value, "utf8").digest();
}

/** The date stamps SigV4 uses: 20260730T131415Z and its 20260730 prefix. */
function timestamps(now: Date): { amzDate: string; dateStamp: string } {
    const amzDate = `${now.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
    return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/** The per-request signing key, derived from the secret down through the scope. */
function signingKey(secret: string, dateStamp: string, region: string): Buffer {
    const date = hmac(`AWS4${secret}`, dateStamp);
    const scopedRegion = hmac(date, region);
    const scopedService = hmac(scopedRegion, SERVICE);
    return hmac(scopedService, "aws4_request");
}

const CRLF = "\r\n";

/** Printable ASCII only: what a header can carry without encoding. */
const PLAIN_HEADER = /^[\x20-\x7e]*$/;

/** A header value with any line break flattened, so no value can start a header of its own. */
function oneLine(value: string): string {
    return value.replace(/[\r\n]+/g, " ");
}

/**
 * A header value as RFC 2047 encoded-words when it is not plain ASCII. Each word
 * holds at most 45 bytes of UTF-8, cut on a character boundary, so it stays under
 * the 75-character limit, and the words are folded onto lines of their own.
 */
function encodeHeader(value: string): string {
    const flat = oneLine(value);
    if (PLAIN_HEADER.test(flat)) return flat;
    const words: string[] = [];
    let chunk = "";
    for (const char of flat) {
        if (Buffer.byteLength(chunk + char, "utf8") > 45) {
            words.push(chunk);
            chunk = "";
        }
        chunk += char;
    }
    if (chunk) words.push(chunk);
    return words
        .map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`)
        .join(`${CRLF} `);
}

/** The From header: the quoted display name when it is ASCII, an encoded one when it is not. */
function fromHeader(config: SesConfig): string {
    const name = config.fromName?.trim();
    if (!name || PLAIN_HEADER.test(name)) return oneLine(formatFrom(config));
    return `${encodeHeader(name.replace(/["\\]/g, ""))} <${oneLine(config.from)}>`;
}

/** Content as base64 in lines of 76, the transfer encoding every part here uses. */
function base64Lines(content: string): string {
    return Buffer.from(content, "utf8")
        .toString("base64")
        .replace(/.{1,76}/g, (line) => `${line}${CRLF}`);
}

/** One MIME part: its headers, a blank line, and its base64 body. */
function part(headers: string[], content: string): string {
    return [...headers, "Content-Transfer-Encoding: base64", "", base64Lines(content)].join(CRLF);
}

/** Parts joined under a boundary, closed by its terminating delimiter. */
function multipart(boundary: string, parts: string[]): string {
    return `${parts.map((body) => `--${boundary}${CRLF}${body}`).join(CRLF)}${CRLF}--${boundary}--${CRLF}`;
}

/**
 * The whole message as RFC 5322 text, for an invitation, which the simple form
 * cannot carry. The event goes where nodemailer puts it for SMTP, so every
 * provider that can state the METHOD reads the same: as a text/calendar
 * alternative beside the text and HTML (RFC 6047), and again as an invite.ics
 * attachment for the clients that only look at files.
 */
function rawMessage(
    config: SesConfig,
    message: EmailMessage,
    calendar: NonNullable<EmailMessage["calendar"]>
): string {
    const mixed = `mixed-${randomBytes(12).toString("hex")}`;
    const alternative = `alt-${randomBytes(12).toString("hex")}`;
    const alternatives = [
        part(["Content-Type: text/plain; charset=utf-8"], message.text),
        ...(message.html ? [part(["Content-Type: text/html; charset=utf-8"], message.html)] : []),
        part([`Content-Type: ${calendarContentType(calendar)}`], calendar.ics)
    ];
    const attachment = part(
        [
            `Content-Type: application/ics; name="${INVITE_FILENAME}"`,
            `Content-Disposition: attachment; filename="${INVITE_FILENAME}"`
        ],
        calendar.ics
    );
    const headers = [
        `From: ${fromHeader(config)}`,
        `To: ${oneLine(message.to)}`,
        `Subject: ${encodeHeader(message.subject)}`,
        `Date: ${new Date().toUTCString()}`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${mixed}"`
    ];
    const body = multipart(mixed, [
        `Content-Type: multipart/alternative; boundary="${alternative}"${CRLF}${CRLF}${multipart(alternative, alternatives)}`,
        attachment
    ]);
    return `${headers.join(CRLF)}${CRLF}${CRLF}${body}`;
}

/** The SES v2 request body: the simple form, or the raw one when there is an invitation. */
function payloadFor(config: SesConfig, message: EmailMessage): string {
    if (message.calendar) {
        return JSON.stringify({
            FromEmailAddress: formatFrom(config),
            Destination: { ToAddresses: [message.to] },
            Content: {
                Raw: {
                    Data: Buffer.from(
                        rawMessage(config, message, message.calendar),
                        "utf8"
                    ).toString("base64")
                }
            }
        });
    }
    const content: Record<string, unknown> = {
        Subject: { Data: message.subject, Charset: "UTF-8" },
        Body: {
            Text: { Data: message.text, Charset: "UTF-8" },
            ...(message.html ? { Html: { Data: message.html, Charset: "UTF-8" } } : {})
        }
    };
    return JSON.stringify({
        FromEmailAddress: formatFrom(config),
        Destination: { ToAddresses: [message.to] },
        Content: { Simple: content }
    });
}

/** Send one message through SES, throwing SES's own error text on refusal. */
export async function sendWithSes(
    config: SesConfig,
    secret: string,
    message: EmailMessage
): Promise<void> {
    const host = `email.${config.region}.amazonaws.com`;
    const body = payloadFor(config, message);
    const bodyHash = sha256Hex(body);
    const { amzDate, dateStamp } = timestamps(new Date());

    // 1. Canonical request. The signed headers are sorted, lowercased, and the
    //    same set named in signedHeaders below.
    const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [
        "POST",
        PATH,
        "",
        "content-type:application/json",
        `host:${host}`,
        `x-amz-content-sha256:${bodyHash}`,
        `x-amz-date:${amzDate}`,
        "",
        signedHeaders,
        bodyHash
    ].join("\n");

    // 2. String to sign, scoped to the day, region and service.
    const scope = `${dateStamp}/${config.region}/${SERVICE}/aws4_request`;
    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

    // 3. Signature, and the Authorization header that carries it.
    const signature = hmac(signingKey(secret, dateStamp, config.region), stringToSign).toString(
        "hex"
    );
    const authorization = `${ALGORITHM} Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    let res: Response;
    try {
        res = await fetch(`https://${host}${PATH}`, {
            method: "POST",
            cache: "no-store",
            headers: {
                "Content-Type": "application/json",
                Authorization: authorization,
                "x-amz-content-sha256": bodyHash,
                "x-amz-date": amzDate
            },
            body
        });
    } catch (caught) {
        throw new Error(
            caught instanceof Error ? `SES unreachable: ${caught.message}` : "SES unreachable"
        );
    }
    if (res.ok) return;
    const detail = (await res.json().catch(() => null)) as {
        message?: string;
        Message?: string;
    } | null;
    throw new Error(
        detail?.message ?? detail?.Message ?? `SES refused the message (HTTP ${res.status})`
    );
}
