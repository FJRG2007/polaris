/**
 * Signing a request the way AWS requires.
 *
 * Written here rather than taken from their SDK, which is a package per service
 * carrying a generated model of every operation that service has, for eight calls.
 * The trade is that a mistake in it is invisible: every one of them comes back as
 * the same unhelpful 403, whichever step was wrong.
 *
 * So what is pinned is each step separately - the scope, the chained signing key,
 * the header format - and the property that ties them together: change any part
 * of the request and the signature changes with it. A signer that ignored the
 * body, or the operation, or the day would pass a "does it produce a signature"
 * test and fail against AWS for ever.
 *
 * These are not AWS's published test vectors: their worked examples sign a
 * different set of headers than this does (it signs the payload hash, which S3
 * requires and the others accept), so a vector would disagree on `SignedHeaders`
 * while both are correct. The signing key chain and the string-to-sign layout are
 * recomputed here from their specification instead.
 */

import { describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { awsHost, signAwsRequest } from "@/lib/integrations/aws-sign";

const CREDENTIALS = {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "eu-west-1"
};

const WHEN = new Date("2026-09-08T10:15:30.000Z");

function signed(overrides: Record<string, unknown> = {}) {
    return signAwsRequest({
        credentials: CREDENTIALS,
        service: "ecs",
        host: awsHost("ecs", CREDENTIALS.region),
        body: JSON.stringify({ cluster: "prod" }),
        target: "AmazonEC2ContainerServiceV20141113.ListServices",
        contentType: "application/x-amz-json-1.1",
        now: WHEN,
        ...overrides
    });
}

/** The authorization header, taken apart. */
function parts(header: string): { credential: string; signedHeaders: string; signature: string } {
    return {
        credential: /Credential=([^,]+)/.exec(header)?.[1] ?? "",
        signedHeaders: /SignedHeaders=([^,]+)/.exec(header)?.[1] ?? "",
        signature: /Signature=([a-f0-9]+)/.exec(header)?.[1] ?? ""
    };
}

describe("what goes on the wire", () => {
    const request = signed();

    it("is addressed to the service in the account's own region", () => {
        expect(request.url).toBe("https://ecs.eu-west-1.amazonaws.com/");
    });

    it("carries the timestamp the signature is for", () => {
        // The header and the scope have to agree, or AWS refuses a signature that
        // is correct for a moment the request does not claim.
        expect(request.headers["x-amz-date"]).toBe("20260908T101530Z");
        expect(parts(request.headers.authorization ?? "").credential).toContain("/20260908/");
    });

    it("names the scope: the day, the region and the service", () => {
        expect(parts(request.headers.authorization ?? "").credential).toBe(
            `${CREDENTIALS.accessKeyId}/20260908/eu-west-1/ecs/aws4_request`
        );
    });

    it("hashes the body it is actually sending", () => {
        expect(request.headers["x-amz-content-sha256"]).toBe(
            createHash("sha256").update(request.body).digest("hex")
        );
    });

    it("signs every header it sends, in order", () => {
        const listed = parts(request.headers.authorization ?? "").signedHeaders.split(";");
        expect(listed).toEqual([...listed].sort());
        for (const name of listed) expect(request.headers[name]).toBeDefined();
        expect(listed).toContain("host");
        expect(listed).toContain("x-amz-target");
    });
});

describe("the signature itself", () => {
    it("is the string to sign, under a key chained from the secret", () => {
        // Their specification, recomputed: four HMACs from the secret through the
        // day, the region and the service, so a signature is worth nothing
        // tomorrow, elsewhere, or against another API.
        const request = signed();
        const { signedHeaders } = parts(request.headers.authorization ?? "");
        const canonicalHeaders = signedHeaders
            .split(";")
            .map((name) => `${name}:${request.headers[name]}\n`)
            .join("");
        const payloadHash = createHash("sha256").update(request.body).digest("hex");
        const canonicalRequest = [
            "POST",
            "/",
            "",
            canonicalHeaders,
            signedHeaders,
            payloadHash
        ].join("\n");
        const scope = "20260908/eu-west-1/ecs/aws4_request";
        const stringToSign = [
            "AWS4-HMAC-SHA256",
            "20260908T101530Z",
            scope,
            createHash("sha256").update(canonicalRequest).digest("hex")
        ].join("\n");

        let key = createHmac("sha256", `AWS4${CREDENTIALS.secretAccessKey}`).update("20260908").digest();
        for (const step of ["eu-west-1", "ecs", "aws4_request"]) {
            key = createHmac("sha256", key).update(step).digest();
        }
        const expected = createHmac("sha256", key).update(stringToSign).digest("hex");

        expect(parts(request.headers.authorization ?? "").signature).toBe(expected);
    });

    it("is the same signature for the same request", () => {
        expect(signed().headers.authorization).toBe(signed().headers.authorization);
    });
});

describe("what the signature covers", () => {
    const base = parts(signed().headers.authorization ?? "").signature;

    it("changes when the body does", () => {
        expect(parts(signed({ body: "{}" }).headers.authorization ?? "").signature).not.toBe(base);
    });

    it("changes when the operation does", () => {
        const other = signed({ target: "AmazonEC2ContainerServiceV20141113.ListClusters" });
        expect(parts(other.headers.authorization ?? "").signature).not.toBe(base);
    });

    it("changes when the day does", () => {
        const other = signed({ now: new Date("2026-09-09T10:15:30.000Z") });
        expect(parts(other.headers.authorization ?? "").signature).not.toBe(base);
    });

    it("changes when the path or the query does", () => {
        expect(parts(signed({ path: "/apps" }).headers.authorization ?? "").signature).not.toBe(base);
        expect(parts(signed({ query: "maxResults=100" }).headers.authorization ?? "").signature).not.toBe(
            base
        );
    });
});

describe("temporary credentials", () => {
    it("send the session token, and sign it", () => {
        // A credential from AssumeRole is refused unless the token is both sent and
        // covered by the signature - the one difference between a temporary key and
        // a permanent one.
        const request = signAwsRequest({
            credentials: { ...CREDENTIALS, sessionToken: "FQoGZXIvYXdzEXAMPLE" },
            service: "ecs",
            host: awsHost("ecs", CREDENTIALS.region),
            now: WHEN
        });
        expect(request.headers["x-amz-security-token"]).toBe("FQoGZXIvYXdzEXAMPLE");
        expect(parts(request.headers.authorization ?? "").signedHeaders).toContain(
            "x-amz-security-token"
        );
    });

    it("leaves the header out entirely when there is none", () => {
        expect(signed().headers["x-amz-security-token"]).toBeUndefined();
    });
});

describe("the query put in the address", () => {
    it("is on the URL as well as in the signature", () => {
        // Signed and not sent is the classic way to spend an afternoon on a 403.
        expect(signed({ path: "/apps", query: "maxResults=100" }).url).toBe(
            "https://ecs.eu-west-1.amazonaws.com/apps?maxResults=100"
        );
    });
});
