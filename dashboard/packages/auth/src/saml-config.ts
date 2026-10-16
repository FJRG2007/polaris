/**
 * Turning what an administrator entered about an identity provider into the
 * configuration the SSO plugin signs people in with.
 *
 * Metadata is read with the same library the plugin uses, so what the admin
 * screen says it found is what sign-in will use. Nothing here fetches: the
 * dashboard fetches a metadata address through its guarded fetch and hands the
 * document over.
 */

import * as core from "@polaris/core";
import { IdentityProvider } from "samlify";
import { X509Certificate } from "node:crypto";

/** What sign-in needs from an identity provider. */
export interface IdpDetails {
    entityId: string;
    ssoUrl: string;
    certificate: string;
}

/** Why an identity provider's details could not be used, as the admin screen names it. */
export type IdpProblem = "metadata" | "certificate" | "certificateExpired" | "ssoUrl";

export class IdpConfigError extends Error {
    constructor(readonly problem: IdpProblem) {
        super(`SAML identity provider configuration: ${problem}`);
    }
}

/** A certificate as PEM, whether it was pasted with its armour or as bare base64. */
export function normalizeCertificate(value: string): string {
    const body = value
        .replace(/-----(BEGIN|END) CERTIFICATE-----/g, "")
        .replace(/\s+/g, "");
    const lines = body.match(/.{1,64}/g) ?? [];
    return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/** The certificate parsed, or an error naming why it cannot sign anything here. */
export function readCertificate(value: string, now = new Date()): { pem: string; validTo: Date } {
    const pem = normalizeCertificate(value);
    let certificate: X509Certificate;
    try {
        certificate = new X509Certificate(pem);
    } catch {
        throw new IdpConfigError("certificate");
    }
    const validTo = new Date(certificate.validTo);
    if (Number.isNaN(validTo.getTime())) throw new IdpConfigError("certificate");
    if (validTo.getTime() <= now.getTime()) throw new IdpConfigError("certificateExpired");
    return { pem, validTo };
}

function firstCertificate(value: string | string[] | null | undefined): string | null {
    const list = Array.isArray(value) ? value : value ? [value] : [];
    return list.find((entry) => typeof entry === "string" && entry.trim().length > 0) ?? null;
}

/** The entity ID, sign-in address and signing certificate a metadata document declares. */
export function readIdpMetadata(xml: string): IdpDetails {
    let entityId: string;
    let ssoUrl: unknown;
    let certificate: string | null;
    try {
        const meta = IdentityProvider({ metadata: xml }).entityMeta;
        entityId = meta.getEntityID();
        // samlify names the binding by its short name.
        ssoUrl = meta.getSingleSignOnService("redirect");
        certificate = firstCertificate(meta.getX509Certificate("signing"));
    } catch {
        throw new IdpConfigError("metadata");
    }
    if (typeof entityId !== "string" || !entityId.trim()) throw new IdpConfigError("metadata");
    if (typeof ssoUrl !== "string" || !ssoUrl.startsWith("https://")) throw new IdpConfigError("ssoUrl");
    if (!certificate) throw new IdpConfigError("certificate");
    return { entityId: entityId.trim(), ssoUrl, certificate: readCertificate(certificate).pem };
}

/** The details from a manual entry, checked the same way metadata is. */
export function manualIdpDetails(source: { entityId: string; ssoUrl: string; certificate: string }): IdpDetails {
    return { entityId: source.entityId, ssoUrl: source.ssoUrl, certificate: readCertificate(source.certificate).pem };
}

/** The plugin's stored configuration for one provider, as JSON. */
export function samlPluginConfig(input: {
    appUrl: string;
    providerId: string;
    idp: IdpDetails;
    mapping: core.SamlMapping;
}): string {
    const sp = core.samlServiceProviderUrls(input.appUrl, input.providerId);
    return JSON.stringify({
        issuer: sp.entityId,
        entryPoint: input.idp.ssoUrl,
        cert: input.idp.certificate,
        callbackUrl: sp.acsUrl,
        audience: sp.entityId,
        idpMetadata: {
            entityID: input.idp.entityId,
            cert: input.idp.certificate,
            singleSignOnService: [{ Binding: core.SAML_REDIRECT_BINDING, Location: input.idp.ssoUrl }]
        },
        spMetadata: { entityID: sp.entityId },
        identifierFormat: core.SAML_EMAIL_NAME_ID,
        mapping: {
            id: "nameID",
            email: input.mapping.email,
            name: input.mapping.name,
            ...(input.mapping.firstName ? { firstName: input.mapping.firstName } : {}),
            ...(input.mapping.lastName ? { lastName: input.mapping.lastName } : {})
        }
    });
}

/** The identity provider details a stored configuration carries, for the admin screen. */
export function storedIdpDetails(samlConfig: string | null): (IdpDetails & { mapping: core.SamlMapping }) | null {
    if (!samlConfig) return null;
    try {
        const parsed = JSON.parse(samlConfig) as {
            entryPoint?: string;
            cert?: string;
            idpMetadata?: { entityID?: string };
            mapping?: Partial<core.SamlMapping>;
        };
        return {
            entityId: parsed.idpMetadata?.entityID ?? "",
            ssoUrl: parsed.entryPoint ?? "",
            certificate: parsed.cert ?? "",
            mapping: { ...core.DEFAULT_SAML_MAPPING, ...parsed.mapping } as core.SamlMapping
        };
    } catch {
        return null;
    }
}
