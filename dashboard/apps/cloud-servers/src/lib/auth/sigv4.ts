/**
 * AWS Signature Version 4, for the EC2 Query API.
 *
 * The dashboard has its own signer for the JSON services it calls; an app cannot
 * import it, and EC2 takes a form-encoded body and query strings it does not
 * cover, so the general form lives here. The steps are AWS's, in their order:
 * canonical request, string to sign, a signing key from four chained HMACs, and
 * the Authorization header.
 *
 * Spec: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 * Test vectors: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv.html
 *
 * Pure. It holds a secret key, so server-only.
 */

import { createHash, createHmac } from "node:crypto";

export interface SigV4Credentials {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
}

export interface SigV4Input {
    readonly method: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly service: string;
    readonly region: string;
    readonly credentials: SigV4Credentials;
    readonly now: Date;
}

const sha256 = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: Buffer | string, data: string) =>
    createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 encoding, which is what AWS signs: `encodeURIComponent` leaves
 *  `!'()*` alone and AWS does not. */
export function uriEncode(value: string): string {
    return encodeURIComponent(value).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    );
}

/** `20150830T123600Z` and `20150830` for an instant. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
    const amzDate = now
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "");
    return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function canonicalQuery(search: URLSearchParams): string {
    return [...search.entries()]
        .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
        .sort(([ak, av], [bk, bv]) =>
            ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1
        )
        .map(([key, value]) => `${key}=${value}`)
        .join("&");
}

/** The derived key: specific to one day, one region and one service. */
export function signingKey(
    secret: string,
    dateStamp: string,
    region: string,
    service: string
): Buffer {
    return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), "aws4_request");
}

/** The canonical request and the headers it signed, for a test to read. */
export function canonicalRequest(input: SigV4Input, headers: Readonly<Record<string, string>>) {
    const url = new URL(input.url);
    const lowered = Object.entries(headers)
        .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const signedHeaders = lowered.map(([name]) => name).join(";");
    const text = [
        input.method,
        url.pathname || "/",
        canonicalQuery(url.searchParams),
        lowered.map(([name, value]) => `${name}:${value}\n`).join(""),
        signedHeaders,
        sha256(input.body)
    ].join("\n");
    return { text, signedHeaders };
}

/** The headers to send: the caller's, plus host, x-amz-date, the session token
 *  when there is one, and Authorization. */
export function signV4(input: SigV4Input): Record<string, string> {
    const { amzDate, dateStamp } = amzDates(input.now);
    const headers: Record<string, string> = {
        ...input.headers,
        host: new URL(input.url).host,
        "x-amz-date": amzDate
    };
    if (input.credentials.sessionToken)
        headers["x-amz-security-token"] = input.credentials.sessionToken;
    const { text, signedHeaders } = canonicalRequest(input, headers);
    const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(text)].join("\n");
    const key = signingKey(
        input.credentials.secretAccessKey,
        dateStamp,
        input.region,
        input.service
    );
    const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return headers;
}
