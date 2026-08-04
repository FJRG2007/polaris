/**
 * Which certificate a name is served with.
 *
 * The rule is not "prefer the one the operator uploaded" but "prefer it while it
 * actually serves". Getting that backwards turns a working site into a browser warning
 * because somebody pasted the wrong file, and it happens silently - which is why the
 * matching is written to be strict in the direction that fails safe.
 */

import { describe, expect, it } from "vitest";
import { certificateCoversHost, judgeCertificate } from "../src/certificates.js";

const NOW = new Date("2026-08-04T12:00:00Z");
const day = 24 * 60 * 60 * 1000;

function valid(names: string[], from = -day, to = 90 * day) {
    return { names, validFrom: new Date(NOW.getTime() + from), validTo: new Date(NOW.getTime() + to) };
}

describe("which names a certificate covers", () => {
    it("matches the name itself, however it is punctuated", () => {
        expect(certificateCoversHost(["app.example.com"], "app.example.com")).toBe(true);
        expect(certificateCoversHost(["App.Example.com"], "app.example.com.")).toBe(true);
    });

    it("matches one label under a wildcard", () => {
        expect(certificateCoversHost(["*.example.com"], "app.example.com")).toBe(true);
    });

    it("does not let a wildcard reach deeper than one label", () => {
        // A browser refuses this, so accepting it here would mean serving a certificate
        // that is then rejected - the exact outcome this check exists to prevent.
        expect(certificateCoversHost(["*.example.com"], "a.b.example.com")).toBe(false);
    });

    it("does not let a wildcard cover the bare domain", () => {
        expect(certificateCoversHost(["*.example.com"], "example.com")).toBe(false);
    });

    it("does not match a suffix that is not a label boundary", () => {
        expect(certificateCoversHost(["*.example.com"], "notexample.com")).toBe(false);
        expect(certificateCoversHost(["app.example.com"], "evil-app.example.com")).toBe(false);
    });

    it("reads every name on the certificate, not only the first", () => {
        expect(certificateCoversHost(["other.example.com", "app.example.com"], "app.example.com")).toBe(true);
    });
});

describe("whether to serve a supplied certificate", () => {
    it("serves one that covers the name and is in date", () => {
        expect(judgeCertificate(valid(["app.example.com"]), "app.example.com", NOW)).toEqual({
            usable: true,
            warning: null
        });
    });

    it("refuses one issued for something else, and says what it is for", () => {
        const verdict = judgeCertificate(valid(["other.example.com"]), "app.example.com", NOW);
        expect(verdict.usable).toBe(false);
        expect(verdict).toMatchObject({ reason: expect.stringContaining("other.example.com") });
    });

    it("refuses one that has expired", () => {
        // The failure that arrives on its own, with nobody touching anything.
        const verdict = judgeCertificate(valid(["app.example.com"], -90 * day, -day), "app.example.com", NOW);
        expect(verdict).toEqual({ usable: false, reason: "This certificate has expired." });
    });

    it("refuses one that is not valid yet", () => {
        const verdict = judgeCertificate(valid(["app.example.com"], day, 90 * day), "app.example.com", NOW);
        expect(verdict).toEqual({ usable: false, reason: "This certificate is not valid yet." });
    });

    it("keeps serving one that is nearly out, and says so", () => {
        // Still better than falling back mid-flight; the operator gets told instead.
        const verdict = judgeCertificate(valid(["app.example.com"], -day, 3 * day), "app.example.com", NOW);
        expect(verdict.usable).toBe(true);
        expect(verdict).toMatchObject({ warning: expect.stringContaining("3 days") });
    });

    it("is exact at the boundary rather than approximate", () => {
        const atExpiry = { names: ["app.example.com"], validFrom: new Date(NOW.getTime() - day), validTo: NOW };
        expect(judgeCertificate(atExpiry, "app.example.com", NOW).usable).toBe(false);
    });
});
