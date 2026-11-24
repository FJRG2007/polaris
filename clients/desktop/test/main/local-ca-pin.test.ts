/**
 * Accepting the instance's own local certificate on its proven local address.
 *
 * What has to hold: a chain is accepted only on one of the instance's other
 * hosts, only when it really is signed by the CA whose SHA-256 was learned over
 * the usual address, and never when no pin was learned. Fixtures are real
 * certificates made with openssl (test/fixtures/local-ca): `ca` signed `leaf`
 * (polaris.local, 192.168.1.20), `rogue` signed `rogue-leaf` for the same names.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCEPT, AUTHORITY_INVALID, USE_CHROMIUM, chainEndsInPin, pinScope, verifyDecision, type ChainLink } from "@/main/local-ca-pin";

const pem = (name: string): string => readFileSync(join(import.meta.dirname, "..", "fixtures", "local-ca", `${name}.crt`), "utf8");
const CA = pem("ca");
const LEAF = pem("leaf");
const ROGUE = pem("rogue");
const ROGUE_LEAF = pem("rogue-leaf");
/** `openssl x509 -noout -fingerprint -sha256` of the fixture CA. */
const CA_SHA256 = "9f4f55c5188f09e449a8264efbbd36b8f4223b1f4b71411c4b748ce4bb897719";

const PRIMARY = "https://polaris.example.com";
const record = {
    id: "instance-0001",
    publicKey: "A".repeat(43),
    addresses: [PRIMARY, "https://polaris.local", "https://192.168.1.20", "http://polaris.lan"],
    localCaSha256: [CA_SHA256]
};
const scope = pinScope(PRIMARY, record);

function chain(...pems: string[]): ChainLink {
    return pems.reduceRight<ChainLink | null>((issuer, data) => ({ data, issuerCert: issuer }), null)!;
}

const ask = (hostname: string, certificate: ChainLink, errorCode = AUTHORITY_INVALID) => ({ hostname, errorCode, certificate });

describe("where the pin applies", () => {
    it("covers the instance's other https hosts only", () => {
        expect(scope).toEqual({ hosts: ["polaris.local", "192.168.1.20"], pins: [CA_SHA256] });
    });

    it("applies nowhere without a learned pin, without a record, or over a plain-HTTP usual address", () => {
        const { localCaSha256: _dropped, ...old } = record;
        expect(pinScope(PRIMARY, old)).toBeNull();
        expect(pinScope(PRIMARY, { ...record, localCaSha256: [] })).toBeNull();
        expect(pinScope(PRIMARY, null)).toBeNull();
        expect(pinScope(null, record)).toBeNull();
        expect(pinScope("http://polaris.example.com", record)).toBeNull();
    });

    it("never covers the usual address's own host, even on another port", () => {
        const sameHost = pinScope(PRIMARY, { ...record, addresses: [PRIMARY, "https://polaris.example.com:8443"] });
        expect(sameHost).toBeNull();
    });
});

describe("the verification answer", () => {
    it("accepts the pinned CA's chain on a proven alternate host, by name and by IP", () => {
        expect(verifyDecision(ask("polaris.local", chain(LEAF, CA)), scope)).toBe(ACCEPT);
        expect(verifyDecision(ask("POLARIS.LOCAL", chain(LEAF, CA)), scope)).toBe(ACCEPT);
        expect(verifyDecision(ask("192.168.1.20", chain(LEAF, CA)), scope)).toBe(ACCEPT);
    });

    it("leaves every other host to Chromium, the usual one included", () => {
        expect(verifyDecision(ask("evil.example", chain(LEAF, CA)), scope)).toBe(USE_CHROMIUM);
        expect(verifyDecision(ask("polaris.example.com", chain(LEAF, CA)), scope)).toBe(USE_CHROMIUM);
        expect(verifyDecision(ask("polaris.lan", chain(LEAF, CA)), scope)).toBe(USE_CHROMIUM);
    });

    it("refuses another CA's chain, and another key's leaf that claims the real CA", () => {
        expect(verifyDecision(ask("polaris.local", chain(ROGUE_LEAF, ROGUE)), scope)).toBe(USE_CHROMIUM);
        expect(verifyDecision(ask("polaris.local", chain(ROGUE_LEAF, CA)), scope)).toBe(USE_CHROMIUM);
        expect(verifyDecision(ask("polaris.local", chain(LEAF)), scope)).toBe(USE_CHROMIUM);
        expect(verifyDecision(ask("polaris.local", chain(CA)), scope)).toBe(USE_CHROMIUM);
    });

    it("refuses when no pin was learned", () => {
        expect(verifyDecision(ask("polaris.local", chain(LEAF, CA)), null)).toBe(USE_CHROMIUM);
    });

    it("overrides nothing but the unknown authority", () => {
        expect(verifyDecision(ask("polaris.local", chain(LEAF, CA), -201), scope)).toBe(USE_CHROMIUM);
        expect(verifyDecision(ask("polaris.local", chain(LEAF, CA), 0), scope)).toBe(USE_CHROMIUM);
    });

    it("refuses a chain for a name the leaf does not carry, or outside its dates", () => {
        expect(chainEndsInPin(chain(LEAF, CA), "other.local", [CA_SHA256])).toBe(false);
        expect(chainEndsInPin(chain(LEAF, CA), "polaris.local", [CA_SHA256], Date.parse("2000-01-01"))).toBe(false);
        expect(chainEndsInPin(chain(LEAF, CA), "polaris.local", [CA_SHA256])).toBe(true);
    });

    it("refuses a chain that cannot be read", () => {
        expect(chainEndsInPin(chain("not a certificate", CA), "polaris.local", [CA_SHA256])).toBe(false);
    });
});
