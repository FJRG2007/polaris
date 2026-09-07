/**
 * Signing a request the way AWS requires, and nothing else.
 *
 * Every AWS API takes the same signature - Signature Version 4 - and the SDK that
 * produces it is enormous: one client package per service, each carrying its own
 * copy of a model of that service. Polaris calls four operations across two
 * services and wants none of that on the server, so the signature is computed
 * here. It is about eighty lines and it is exactly specified, which is the case
 * where writing it beats depending on it.
 *
 * The steps are AWS's own, in their order, because every one of them is load
 * bearing and the failure mode for all of them is the same unhelpful 403:
 *
 * 1. a **canonical request** - method, path, query, the signed headers, and the
 *    hash of the body;
 * 2. a **string to sign** - the algorithm, the timestamp, the scope
 *    (date/region/service) and the hash of that canonical request;
 * 3. a **signing key** derived by four chained HMACs from the secret, so the key
 *    that signs is specific to one day, one region and one service and is useless
 *    anywhere else;
 * 4. the **Authorization header**, naming the key, the scope and which headers
 *    were signed.
 *
 * Deliberately narrow: POST with a JSON body, which is what both the JSON-protocol
 * services and the REST ones here use. No presigned URLs, no chunked payloads, no
 * session-token-less assumptions beyond a temporary credential carrying one.
 *
 * Pure, and server-only - it holds somebody's secret key.
 */

import { createHash, createHmac } from "node:crypto";

/** What an account signs with. `sessionToken` is present only for temporary
 *  credentials, and then it has to be signed and sent or the call is refused. */
export interface AwsCredentials {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
    readonly region: string;
}

export interface SignedRequest {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
}

function sha256(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
    return createHmac("sha256", key).update(value, "utf8").digest();
}

/** `20260907T101530Z`, and its date half. AWS wants both, and they have to agree
 *  or the signature is for a scope the request does not claim. */
function stamps(now: Date): { full: string; day: string } {
    const full = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    return { full, day: full.slice(0, 8) };
}

/**
 * Every header that is signed, lower-cased and in order.
 *
 * Host and the timestamp are mandatory; the content type and the operation target
 * are signed because they are part of what the request means, and a proxy that
 * rewrote either would be a different request. The session token is signed where
 * there is one.
 */
function canonicalHeaders(headers: Readonly<Record<string, string>>): {
    canonical: string;
    signed: string;
} {
    const entries = Object.entries(headers)
        .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return {
        canonical: entries.map(([name, value]) => `${name}:${value}\n`).join(""),
        signed: entries.map(([name]) => name).join(";")
    };
}

/**
 * One signed POST.
 *
 * `path` is already encoded by the caller where it has to be - an Amplify branch
 * name can contain a slash, and whether that slash is a path separator is the
 * caller's question, not this function's.
 */
export function signAwsRequest(input: {
    readonly credentials: AwsCredentials;
    /** `ecs`, `amplify`, `apprunner` - the service's own name in the signature. */
    readonly service: string;
    readonly host: string;
    readonly method?: string;
    readonly path?: string;
    readonly query?: string;
    readonly body?: string;
    /** The operation, for the JSON-protocol services that name it in a header. */
    readonly target?: string;
    readonly contentType?: string;
    readonly now?: Date;
}): SignedRequest {
    const {
        credentials,
        service,
        host,
        method = "POST",
        path = "/",
        query = "",
        body = "",
        target,
        contentType = "application/json",
        now = new Date()
    } = input;

    const { full, day } = stamps(now);
    const payloadHash = sha256(body);
    const headers: Record<string, string> = {
        host,
        "content-type": contentType,
        "x-amz-date": full,
        "x-amz-content-sha256": payloadHash,
        ...(target ? { "x-amz-target": target } : {}),
        ...(credentials.sessionToken ? { "x-amz-security-token": credentials.sessionToken } : {})
    };

    const { canonical, signed } = canonicalHeaders(headers);
    const canonicalRequest = [method, path, query, canonical, signed, payloadHash].join("\n");
    const scope = `${day}/${credentials.region}/${service}/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", full, scope, sha256(canonicalRequest)].join("\n");

    // The chain that makes the key specific to a day, a region and a service - so a
    // signature that leaks is worth nothing tomorrow, somewhere else, or against
    // anything but this API.
    const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, day);
    const regionKey = hmac(dateKey, credentials.region);
    const serviceKey = hmac(regionKey, service);
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

    return {
        url: `https://${host}${path}${query ? `?${query}` : ""}`,
        headers: {
            ...headers,
            authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`
        },
        body
    };
}

/** The host an AWS service answers on in one region. Their own convention, and
 *  the one exception nobody here needs (a global service) does not arise. */
export function awsHost(service: string, region: string): string {
    return `${service}.${region}.amazonaws.com`;
}
