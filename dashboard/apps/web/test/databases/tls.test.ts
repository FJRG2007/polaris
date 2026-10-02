/**
 * What each encryption mode actually checks. The failure this guards against is
 * a mode that says "verify" and hands the driver `rejectUnauthorized: false`,
 * which is what every engine did before the modes existed.
 */

import { describe, expect, it } from "vitest";
import { legacyTlsMode, tlsConnectOptions, tlsRefusal, NO_TLS, type DataTls } from "@/lib/data/tls";

const base: DataTls = {
    mode: "verify-full",
    ca: null,
    clientCert: null,
    clientKey: null,
    name: "db.example.com"
};

describe("tlsConnectOptions", () => {
    it("is nothing at all when encryption is off", () => {
        expect(tlsConnectOptions(NO_TLS)).toBeNull();
    });

    it("checks nothing only in require, the mode that says so", () => {
        expect(tlsConnectOptions({ ...base, mode: "require" })).toMatchObject({
            rejectUnauthorized: false
        });
    });

    it("verifies the chain and the name in verify-full", () => {
        const options = tlsConnectOptions(base)!;
        expect(options.rejectUnauthorized).toBe(true);
        expect(options.servername).toBe("db.example.com");
        const wrong = options.checkServerIdentity!("db.example.com", {
            subject: { CN: "other.example.com" },
            subjectaltname: "DNS:other.example.com"
        } as never);
        expect(wrong).toBeInstanceOf(Error);
    });

    it("verifies the chain but not the name in verify-ca", () => {
        const options = tlsConnectOptions({ ...base, mode: "verify-ca", ca: "PEM" })!;
        expect(options.rejectUnauthorized).toBe(true);
        expect(options.ca).toBe("PEM");
        expect(options.checkServerIdentity!("x", {} as never)).toBeUndefined();
    });

    it("checks the name the connection was saved with, not the address dialled", () => {
        const options = tlsConnectOptions({ ...base, name: "db.example.com" })!;
        const right = options.checkServerIdentity!("203.0.113.9", {
            subject: { CN: "db.example.com" },
            subjectaltname: "DNS:db.example.com"
        } as never);
        expect(right).toBeUndefined();
    });

    it("sends no SNI for an address", () => {
        expect(tlsConnectOptions({ ...base, name: "203.0.113.9" })!.servername).toBeUndefined();
    });
});

describe("a row saved before modes existed", () => {
    it("reads the old switch as what it did", () => {
        expect(legacyTlsMode(true, null)).toBe("require");
        expect(legacyTlsMode(false, null)).toBe("disable");
        expect(legacyTlsMode(true, "verify-full")).toBe("verify-full");
    });
});

describe("tlsRefusal", () => {
    it("says an untrusted certificate as itself, through a driver's wrapping", () => {
        const wrapped = Object.assign(new Error("connect failed"), {
            cause: Object.assign(new Error("self-signed"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" })
        });
        expect(tlsRefusal(wrapped, "db.example.com")).toMatch(/not signed by an authority/);
    });

    it("names the host a certificate was not for", () => {
        const error = Object.assign(new Error("x"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
        expect(tlsRefusal(error, "db.example.com")).toBe(
            "The database's certificate is not for db.example.com, so nothing was sent to it."
        );
    });

    it("leaves anything else alone", () => {
        expect(tlsRefusal(new Error("password authentication failed"), null)).toBeNull();
    });
});
