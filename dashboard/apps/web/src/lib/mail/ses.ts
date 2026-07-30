/**
 * Amazon SES v2 over its HTTPS API, signed with Signature Version 4.
 *
 * Sending one message needs one request, so this signs that request directly
 * rather than pulling in the AWS SDK - which would add several dozen packages to
 * the supply chain to reach a single endpoint. The signing steps below follow
 * the SigV4 specification in order; the comments name each one so the code can
 * be checked against it.
 */

import { createHash, createHmac } from "node:crypto";
import { formatFrom, type SesConfig } from "@polaris/core";
import type { EmailMessage } from "./types";

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

/** The SES v2 request body for a simple (non-raw) message. */
function payloadFor(config: SesConfig, message: EmailMessage): string {
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
export async function sendWithSes(config: SesConfig, secret: string, message: EmailMessage): Promise<void> {
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
    const signature = hmac(signingKey(secret, dateStamp, config.region), stringToSign).toString("hex");
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
        throw new Error(caught instanceof Error ? `SES unreachable: ${caught.message}` : "SES unreachable");
    }
    if (res.ok) return;
    const detail = (await res.json().catch(() => null)) as { message?: string; Message?: string } | null;
    throw new Error(detail?.message ?? detail?.Message ?? `SES refused the message (HTTP ${res.status})`);
}
