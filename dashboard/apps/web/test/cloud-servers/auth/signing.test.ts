/**
 * The signatures Cloud servers computes by hand: AWS Signature Version 4 against
 * AWS's own published examples, a Google service-account assertion that verifies
 * with the key's public half, and the throwaway SSH key line a provider is given.
 */

import { describe, expect, it } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { opensshRsaLine, throwawaySshKey } from "@polaris-app/cloud-servers/src/lib/auth/throwaway";
import {
    amzDates,
    canonicalRequest,
    signingKey,
    signV4
} from "@polaris-app/cloud-servers/src/lib/auth/sigv4";
import {
    buildAssertion,
    COMPUTE_SCOPE,
    GOOGLE_TOKEN_URL
} from "@polaris-app/cloud-servers/src/lib/auth/google-jwt";

// AWS's documented example credentials (not a real key).
const EXAMPLE = {
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
};
const NOW = new Date("2015-08-30T12:36:00Z");

describe("AWS Signature Version 4", () => {
    it("formats the request date as AWS does", () => {
        expect(amzDates(NOW)).toEqual({ amzDate: "20150830T123600Z", dateStamp: "20150830" });
    });

    it("derives the documented signing key", () => {
        // https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
        expect(
            signingKey(EXAMPLE.secretAccessKey, "20150830", "us-east-1", "iam").toString("hex")
        ).toBe("c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");
    });

    it("signs the IAM ListUsers example to AWS's published signature", () => {
        const headers = signV4({
            method: "GET",
            url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
            headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
            body: "",
            service: "iam",
            region: "us-east-1",
            credentials: EXAMPLE,
            now: NOW
        });
        expect(headers.authorization).toBe(
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
        );
    });

    it("signs the test suite's get-vanilla request", () => {
        const headers = signV4({
            method: "GET",
            url: "https://example.amazonaws.com/",
            headers: {},
            body: "",
            service: "service",
            region: "us-east-1",
            credentials: EXAMPLE,
            now: NOW
        });
        expect(headers.authorization).toBe(
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
        );
    });

    it("sorts query parameters and encodes them the RFC 3986 way", () => {
        const { text } = canonicalRequest(
            {
                method: "GET",
                url: "https://example.amazonaws.com/?Param2=value2&Param1=value(1)*",
                headers: {},
                body: "",
                service: "service",
                region: "us-east-1",
                credentials: EXAMPLE,
                now: NOW
            },
            { host: "example.amazonaws.com" }
        );
        expect(text.split("\n")[2]).toBe("Param1=value%281%29%2A&Param2=value2");
    });

    it("signs and sends a session token when there is one", () => {
        const headers = signV4({
            method: "POST",
            url: "https://ec2.eu-west-1.amazonaws.com/",
            headers: {},
            body: "Action=DescribeRegions",
            service: "ec2",
            region: "eu-west-1",
            credentials: { ...EXAMPLE, sessionToken: "fixture-session-token" },
            now: NOW
        });
        expect(headers["x-amz-security-token"]).toBe("fixture-session-token");
        expect(headers.authorization).toContain(
            "SignedHeaders=host;x-amz-date;x-amz-security-token"
        );
    });
});

describe("Google service-account assertion", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const account = {
        type: "service_account" as const,
        project_id: "fixture-project",
        client_email: "fixture@fixture-project.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    };

    it("is an RS256 JWT for the Compute scope that verifies with the public key", () => {
        const jwt = buildAssertion(account, COMPUTE_SCOPE, new Date("2026-01-01T00:00:00Z"));
        const [header, claims, signature] = jwt.split(".");
        expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
            alg: "RS256",
            typ: "JWT"
        });
        expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
            iss: account.client_email,
            scope: COMPUTE_SCOPE,
            aud: GOOGLE_TOKEN_URL,
            iat: 1767225600,
            exp: 1767229200
        });
        const verifier = createVerify("RSA-SHA256");
        verifier.update(`${header}.${claims}`);
        expect(verifier.verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
    });
});

describe("throwaway SSH key", () => {
    function readBlob(line: string) {
        const [type, b64] = line.split(" ");
        const blob = Buffer.from(b64!, "base64");
        const parts: Buffer[] = [];
        let at = 0;
        while (at < blob.length) {
            const length = blob.readUInt32BE(at);
            parts.push(blob.subarray(at + 4, at + 4 + length));
            at += 4 + length;
        }
        return { type, parts };
    }

    it("writes ssh-rsa, e and n as length-prefixed fields", () => {
        const line = opensshRsaLine(Buffer.from([1, 0, 1]), Buffer.from([0x80, 0x01]), "fixture");
        const { type, parts } = readBlob(line);
        expect(type).toBe("ssh-rsa");
        expect(parts[0]!.toString()).toBe("ssh-rsa");
        expect([...parts[1]!]).toEqual([1, 0, 1]);
        // A leading zero keeps an n with its top bit set positive.
        expect([...parts[2]!]).toEqual([0, 0x80, 0x01]);
        expect(line.endsWith(" fixture")).toBe(true);
    });

    it("generates a 3072-bit key", () => {
        const { parts } = readBlob(throwawaySshKey());
        expect(parts[2]!.length).toBe(385);
    });
});
