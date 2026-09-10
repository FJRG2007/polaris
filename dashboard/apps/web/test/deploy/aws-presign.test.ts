/**
 * Presigned URLs, against AWS's own published example.
 *
 * Unlike the header signature (see aws-signature.test.ts), a presigned GET signs
 * exactly one header and an unsigned payload, which is what AWS's worked example
 * for query-string authentication does - so here the published vector applies
 * as it is, and the signature is compared byte for byte.
 */

import { describe, expect, it } from "vitest";
import { presignAwsUrl } from "@/lib/integrations/aws-sign";

const EXAMPLE = {
    credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        region: "us-east-1"
    },
    host: "examplebucket.s3.amazonaws.com",
    path: "/test.txt",
    expiresIn: 86_400,
    now: new Date("2013-05-24T00:00:00Z")
};

describe("presignAwsUrl", () => {
    it("reproduces the signature in AWS's query-string authentication example", () => {
        const url = new URL(presignAwsUrl(EXAMPLE));
        expect(url.searchParams.get("X-Amz-Signature")).toBe(
            "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
        );
        expect(url.searchParams.get("X-Amz-Credential")).toBe(
            "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request"
        );
        expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
        expect(url.origin).toBe("https://examplebucket.s3.amazonaws.com");
    });

    it("signs the method, so a download link cannot be used to upload", () => {
        const get = new URL(presignAwsUrl(EXAMPLE)).searchParams.get("X-Amz-Signature");
        const put = new URL(presignAwsUrl({ ...EXAMPLE, method: "PUT" })).searchParams.get(
            "X-Amz-Signature"
        );
        expect(put).not.toBe(get);
    });

    it("encodes a key the way S3 signs it, keeping its slashes", () => {
        const url = presignAwsUrl({
            ...EXAMPLE,
            protocol: "http",
            host: "files:8333",
            path: "/media/a b/(1)!.png"
        });
        expect(url.startsWith("http://files:8333/media/a%20b/%281%29%21.png?")).toBe(true);
    });

    it("refuses a lifetime SigV4 does not allow", () => {
        expect(() => presignAwsUrl({ ...EXAMPLE, expiresIn: 604_801 })).toThrow();
        expect(() => presignAwsUrl({ ...EXAMPLE, expiresIn: 0 })).toThrow();
    });
});
