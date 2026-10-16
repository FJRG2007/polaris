/**
 * Reading an identity provider's details the way the admin screen does, with
 * the test identity provider's certificate from `test/fixtures`.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    IdpConfigError,
    manualIdpDetails,
    readCertificate,
    readIdpMetadata,
    samlPluginConfig,
    storedIdpDetails
} from "../../src/saml-config.js";

const CERT = readFileSync(join(__dirname, "../fixtures/test-idp.crt"), "utf8");
const BARE = CERT.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");

function metadata(ssoUrl = "https://idp.fixture.test/sso"): string {
    return (
        `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="https://idp.fixture.test/metadata">` +
        `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
        `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${BARE}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` +
        `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${ssoUrl}"/>` +
        `</md:IDPSSODescriptor></md:EntityDescriptor>`
    );
}

function problem(run: () => unknown): string | null {
    try {
        run();
        return null;
    } catch (error) {
        return error instanceof IdpConfigError ? error.problem : "other";
    }
}

describe("identity provider details", () => {
    it("reads the entity ID, sign-in address and certificate from metadata", () => {
        const details = readIdpMetadata(metadata());
        expect(details.entityId).toBe("https://idp.fixture.test/metadata");
        expect(details.ssoUrl).toBe("https://idp.fixture.test/sso");
        expect(details.certificate.replace(/\s+/g, "")).toContain(BARE);
    });

    it("refuses metadata that is not, or that signs in over plain http", () => {
        expect(problem(() => readIdpMetadata("<html></html>"))).toBe("metadata");
        expect(problem(() => readIdpMetadata(metadata("http://idp.fixture.test/sso")))).toBe(
            "ssoUrl"
        );
    });

    it("accepts a certificate with or without its armour, and refuses junk or an expired one", () => {
        expect(readCertificate(BARE).pem).toBe(readCertificate(CERT).pem);
        expect(problem(() => readCertificate("not a certificate"))).toBe("certificate");
        expect(problem(() => readCertificate(CERT, new Date("2999-01-01")))).toBe(
            "certificateExpired"
        );
    });

    it("builds the plugin configuration with this deployment's own addresses", () => {
        const idp = manualIdpDetails({
            entityId: "https://idp.fixture.test/metadata",
            ssoUrl: "https://idp.fixture.test/sso",
            certificate: CERT
        });
        const json = samlPluginConfig({
            appUrl: "https://polaris.example.test/",
            providerId: "saml-fixture000001",
            idp,
            mapping: { email: "mail", name: "cn", firstName: undefined, lastName: undefined }
        });
        const config = JSON.parse(json);
        expect(config.callbackUrl).toBe(
            "https://polaris.example.test/api/auth/sso/saml2/sp/acs/saml-fixture000001"
        );
        expect(config.audience).toBe(config.spMetadata.entityID);
        expect(config.mapping).toEqual({ id: "nameID", email: "mail", name: "cn" });
        expect(storedIdpDetails(json)?.mapping.email).toBe("mail");
        expect(storedIdpDetails("{")).toBeNull();
    });
});
