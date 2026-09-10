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
 * services and the REST ones here use, and query-string presigned URLs for the
 * object stores Polaris runs. No chunked payloads, no session-token-less
 * assumptions beyond a temporary credential carrying one.
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

/**
 * AWS's URI encoding: every byte but the unreserved characters, upper-case hex.
 * `encodeURIComponent` leaves `!'()*` alone, which AWS does not - a key with a
 * parenthesis would sign one string and send another.
 */
function awsEncode(value: string, keepSlash = false): string {
    return Array.from(Buffer.from(value, "utf8"))
        .map((byte) => {
            const char = String.fromCharCode(byte);
            if (/[A-Za-z0-9\-._~]/.test(char) || (keepSlash && char === "/")) return char;
            return `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
        })
        .join("");
}

/**
 * A presigned URL: the signature travels in the query string instead of a
 * header, so whoever holds the URL can make that one request - a download or an
 * upload of one object - until it expires, without the key that signed it.
 *
 * Only `host` is signed and the payload is `UNSIGNED-PAYLOAD`, as S3 defines for
 * a URL handed to a browser that cannot know the body's hash in advance. The
 * object key is encoded segment by segment, its slashes kept, because S3 signs
 * the path exactly as it is sent.
 */
export function presignAwsUrl(input: {
    readonly credentials: AwsCredentials;
    readonly service?: string;
    /** `http` for a store reached on a private network, `https` otherwise. */
    readonly protocol?: "http" | "https";
    /** Host and, when it is not the protocol's default, `:port`. */
    readonly host: string;
    /** The path, unencoded: `/bucket/key`. */
    readonly path: string;
    readonly method?: "GET" | "PUT" | "HEAD" | "DELETE";
    /** Seconds, 1 to 604800 (seven days, SigV4's ceiling). */
    readonly expiresIn: number;
    readonly now?: Date;
}): string {
    const {
        credentials,
        service = "s3",
        protocol = "https",
        host,
        path,
        method = "GET",
        expiresIn,
        now = new Date()
    } = input;
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 604_800) {
        throw new Error("A presigned URL lasts between one second and seven days");
    }
    const { full, day } = stamps(now);
    const scope = `${day}/${credentials.region}/${service}/aws4_request`;
    const params: [string, string][] = [
        ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
        ["X-Amz-Credential", `${credentials.accessKeyId}/${scope}`],
        ["X-Amz-Date", full],
        ["X-Amz-Expires", String(expiresIn)],
        ["X-Amz-SignedHeaders", "host"],
        ...(credentials.sessionToken
            ? ([["X-Amz-Security-Token", credentials.sessionToken]] as [string, string][])
            : [])
    ];
    const query = params
        .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, value]) => `${key}=${value}`)
        .join("&");
    const canonicalPath = awsEncode(path.startsWith("/") ? path : `/${path}`, true);
    const canonicalRequest = [
        method,
        canonicalPath,
        query,
        `host:${host}\n`,
        "host",
        "UNSIGNED-PAYLOAD"
    ].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", full, scope, sha256(canonicalRequest)].join("\n");
    const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, day);
    const regionKey = hmac(dateKey, credentials.region);
    const serviceKey = hmac(regionKey, service);
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
    return `${protocol}://${host}${canonicalPath}?${query}&X-Amz-Signature=${signature}`;
}

/** The host an AWS service answers on in one region. Their own convention, and
 *  the one exception nobody here needs (a global service) does not arise. */
export function awsHost(service: string, region: string): string {
    return `${service}.${region}.amazonaws.com`;
}
