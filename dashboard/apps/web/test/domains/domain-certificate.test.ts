/**
 * Reviewing a certificate an operator actually pasted in.
 *
 * The rules themselves are asserted in core against plain facts. What is asserted here
 * is the part that only a real certificate can show: that the PEM parses, that the
 * names come off it the way the rules expect, and that a key which does not belong to
 * it is caught - because serving a certificate the edge cannot prove is a site that
 * fails to load rather than a site with a warning on it.
 *
 * Generated in the test with openssl rather than committed, so there is no private key
 * in the repository and nothing to expire in a year and start failing on its own.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

const dir = mkdtempSync(join(tmpdir(), "polaris-cert-test-"));

/** A self-signed certificate for `cn`, valid for `days`. */
function issue(name: string, cn: string, days: number): { certPem: string; keyPem: string } {
    const keyPath = join(dir, `${name}.key`);
    const crtPath = join(dir, `${name}.crt`);
    execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", keyPath, "-out", crtPath,
        "-days", String(days), "-subj", `/CN=${cn}`,
        "-addext", `subjectAltName=DNS:${cn}`
    ]);
    return { certPem: readFileSync(crtPath, "utf8"), keyPem: readFileSync(keyPath, "utf8") };
}

const mine = issue("mine", "app.example.com", 90);
const other = issue("other", "other.example.com", 90);

const { reviewCertificate } = await import("@/lib/domain-cert-service");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("reviewing a pasted certificate", () => {
    it("accepts one issued for the hostname, with its own key", () => {
        const review = reviewCertificate(mine.certPem, mine.keyPem, "app.example.com");
        expect(review.verdict.usable).toBe(true);
        expect(review.names).toContain("app.example.com");
        expect(review.expiresAt).toBeInstanceOf(Date);
    });

    it("refuses one issued for a different name", () => {
        const review = reviewCertificate(other.certPem, other.keyPem, "app.example.com");
        expect(review.verdict).toMatchObject({ usable: false, reason: expect.stringContaining("other.example.com") });
    });

    it("refuses a key that belongs to a different certificate", () => {
        // The edge would present a certificate it cannot complete a handshake with, so
        // the site would not load at all - worse than the warning this feature replaces.
        const review = reviewCertificate(mine.certPem, other.keyPem, "app.example.com");
        expect(review.verdict).toMatchObject({ usable: false, reason: expect.stringContaining("does not belong") });
    });

    it("refuses something that is not a certificate", () => {
        const review = reviewCertificate("not a certificate", mine.keyPem, "app.example.com");
        expect(review.verdict).toMatchObject({ usable: false });
        expect(review.names).toEqual([]);
    });

    it("refuses something that is not a key", () => {
        const review = reviewCertificate(mine.certPem, "not a key", "app.example.com");
        expect(review.verdict).toMatchObject({ usable: false, reason: expect.stringContaining("private key") });
    });

    it("refuses one that has already expired", () => {
        // Judged at a moment past its window rather than by waiting for one to lapse.
        const review = reviewCertificate(
            mine.certPem,
            mine.keyPem,
            "app.example.com",
            new Date(Date.now() + 200 * 24 * 60 * 60 * 1000)
        );
        expect(review.verdict).toMatchObject({ usable: false, reason: "This certificate has expired." });
    });
});
