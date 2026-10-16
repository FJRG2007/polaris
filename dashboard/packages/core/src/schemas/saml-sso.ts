/**
 * SAML single sign-on: what an administrator configures, and the rules every
 * side of the sign-in agrees on.
 *
 * Kept free of Node so the admin form validates against the same schema the
 * server action parses with. Certificates and metadata are checked once more on
 * the server, where X.509 parsing and the metadata fetch are available.
 */

import { z } from "zod";

/** The most domains one identity provider may claim. */
export const SAML_MAX_DOMAINS = 20;

/** The largest pasted or fetched metadata document accepted, in characters. */
export const SAML_MAX_METADATA_LENGTH = 256 * 1024;

/** The binding the sign-in request is sent with. */
export const SAML_REDIRECT_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";

/** The name ID format asked for: the address, which is what accounts are keyed on. */
export const SAML_EMAIL_NAME_ID = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";

/**
 * The words the schemas below refuse a value with. Exported so a screen can
 * translate them by these exact words rather than show the English source.
 */
export const SAML_MESSAGES = {
    domain: "Enter a domain such as example.com.",
    attribute: "Enter the attribute name.",
    metadataUrl: "Enter the full metadata address, starting with https://.",
    metadataUrlHttps: "The metadata address has to use https://.",
    metadataXml: "Paste the metadata XML.",
    metadataTooLarge: "This metadata is too large.",
    notMetadata: "This is not SAML metadata: it has no EntityDescriptor.",
    entityId: "Enter the identity provider's entity ID.",
    ssoUrl: "Enter the full sign-in address, starting with https://.",
    ssoUrlHttps: "The sign-in address has to use https://.",
    certificate: "Paste the signing certificate.",
    certificateTooLarge: "This certificate is too large.",
    name: "Enter a name.",
    domainsMin: "Add at least one domain.",
    domainsMax: `Use at most ${SAML_MAX_DOMAINS} domains.`
} as const;

const DOMAIN_PATTERN =
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

/** One domain the way it is stored: trimmed, lower case, no leading "@" or trailing dot. */
export function normalizeSamlDomain(value: string): string {
    return value.trim().toLowerCase().replace(/^@+/, "").replace(/\.+$/, "");
}

/** The domain of an address, normalized, or null when it has none. */
export function emailDomain(email: string): string | null {
    const at = email.trim().lastIndexOf("@");
    if (at < 1) return null;
    const domain = normalizeSamlDomain(email.trim().slice(at + 1));
    return DOMAIN_PATTERN.test(domain) ? domain : null;
}

/** The stored comma-separated list, split back into domains. */
export function parseSamlDomains(stored: string): string[] {
    return stored.split(",").map(normalizeSamlDomain).filter(Boolean);
}

/** Whether `domain` is one of `domains` or a subdomain of one - the plugin's own rule. */
export function samlDomainMatches(domain: string, domains: readonly string[]): boolean {
    const search = normalizeSamlDomain(domain);
    return domains.some((candidate) => search === candidate || search.endsWith(`.${candidate}`));
}

const domainSchema = z
    .string()
    .transform(normalizeSamlDomain)
    .refine((value) => DOMAIN_PATTERN.test(value), { message: SAML_MESSAGES.domain });

const attributeSchema = z
    .string()
    .trim()
    .min(1, SAML_MESSAGES.attribute)
    .max(200, "Use at most 200 characters.");

const optionalAttributeSchema = z
    .string()
    .trim()
    .max(200, "Use at most 200 characters.")
    .optional()
    .transform((value) => value || undefined);

/** Where the identity provider's details come from. */
export const samlSourceSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("metadataUrl"),
        url: z
            .string()
            .trim()
            .max(2048, "Use at most 2048 characters.")
            .url(SAML_MESSAGES.metadataUrl)
            .refine((value) => value.startsWith("https://"), {
                message: SAML_MESSAGES.metadataUrlHttps
            })
    }),
    z.object({
        kind: z.literal("metadataXml"),
        xml: z
            .string()
            .trim()
            .min(1, SAML_MESSAGES.metadataXml)
            .max(SAML_MAX_METADATA_LENGTH, SAML_MESSAGES.metadataTooLarge)
            .refine((value) => /<(?:\w+:)?EntityDescriptor[\s>]/.test(value), {
                message: SAML_MESSAGES.notMetadata
            })
    }),
    z.object({
        kind: z.literal("manual"),
        entityId: z
            .string()
            .trim()
            .min(1, SAML_MESSAGES.entityId)
            .max(1024, "Use at most 1024 characters."),
        ssoUrl: z
            .string()
            .trim()
            .max(2048, "Use at most 2048 characters.")
            .url(SAML_MESSAGES.ssoUrl)
            .refine((value) => value.startsWith("https://"), {
                message: SAML_MESSAGES.ssoUrlHttps
            }),
        certificate: z
            .string()
            .trim()
            .min(1, SAML_MESSAGES.certificate)
            .max(16 * 1024, SAML_MESSAGES.certificateTooLarge)
    }),
    /** Keep the details already saved: only meaningful when editing a provider. */
    z.object({ kind: z.literal("current") })
]);

export type SamlSource = z.infer<typeof samlSourceSchema>;

/** Which assertion attributes carry the address and the name. */
export const samlMappingSchema = z.object({
    email: attributeSchema,
    name: attributeSchema,
    firstName: optionalAttributeSchema,
    lastName: optionalAttributeSchema
});

export type SamlMapping = z.infer<typeof samlMappingSchema>;

/** The attribute names most identity providers send unless told otherwise. */
export const DEFAULT_SAML_MAPPING: SamlMapping = {
    email: "email",
    name: "displayName",
    firstName: "givenName",
    lastName: "surname"
};

/** An identity provider as the admin form submits it. */
export const samlProviderInputSchema = z.object({
    name: z.string().trim().min(1, SAML_MESSAGES.name).max(80, "Use at most 80 characters."),
    domains: z
        .array(domainSchema)
        .min(1, SAML_MESSAGES.domainsMin)
        .max(SAML_MAX_DOMAINS, SAML_MESSAGES.domainsMax)
        .transform((domains) => [...new Set(domains)]),
    source: samlSourceSchema,
    mapping: samlMappingSchema,
    allowSignUp: z.boolean(),
    enforced: z.boolean()
});

export type SamlProviderInput = z.infer<typeof samlProviderInputSchema>;

/** The provider id the plugin routes on: a fixed prefix and a random suffix, URL-safe. */
export const SAML_PROVIDER_ID_PATTERN = /^saml-[a-z0-9]{12,32}$/;

/** The addresses an administrator copies into the identity provider. */
export function samlServiceProviderUrls(
    appUrl: string,
    providerId: string
): {
    entityId: string;
    acsUrl: string;
    metadataUrl: string;
} {
    const base = `${appUrl.replace(/\/+$/, "")}/api/auth`;
    const metadataUrl = `${base}/sso/saml2/sp/metadata?providerId=${encodeURIComponent(providerId)}`;
    return {
        entityId: metadataUrl,
        acsUrl: `${base}/sso/saml2/sp/acs/${encodeURIComponent(providerId)}`,
        metadataUrl
    };
}

/** The DNS TXT record that proves the domains belong to whoever configured them. */
export function samlDomainRecord(domain: string, token: string): { name: string; value: string } {
    return { name: `_polaris-sso.${domain}`, value: `polaris-sso=${token}` };
}

/** What sign-in needs to know about one provider. */
export interface SamlDomainPolicy {
    readonly providerId: string;
    readonly domains: readonly string[];
    readonly enforced: boolean;
    readonly domainVerified: boolean;
}

/** The provider an address signs in through, or null when its domain has none. */
export function providerForEmail<T extends SamlDomainPolicy>(
    email: string,
    providers: readonly T[]
): T | null {
    const domain = emailDomain(email);
    if (!domain) return null;
    return providers.find((provider) => samlDomainMatches(domain, provider.domains)) ?? null;
}

/**
 * Whether a password sign-in for this address is refused because its domain has
 * to sign in through its identity provider.
 *
 * Only a verified provider can enforce: an unverified one cannot sign anybody in,
 * so enforcing it would lock the domain out. A platform administrator is never
 * refused - their password is the way back in when the provider is broken or
 * misconfigured, and without it a bad certificate locks out the whole instance.
 */
export function passwordSignInRefused(
    account: { email: string; isAdmin: boolean },
    providers: readonly SamlDomainPolicy[]
): boolean {
    if (account.isAdmin) return false;
    const provider = providerForEmail(account.email, providers);
    return Boolean(provider?.enforced && provider.domainVerified);
}

const PLACEHOLDER_ORIGIN = "http://polaris.invalid";

/**
 * A same-origin path to return to, or null for anything else.
 *
 * Only a path is honoured - never a scheme, a host, a protocol-relative `//x`
 * or a backslash form a browser reads as one - so the address a sign-in returns
 * to can never take somebody off this deployment.
 */
export function sameOriginPath(target: string | null | undefined): string | null {
    if (!target || !target.startsWith("/") || /^[\\/]{2}/.test(target) || target.includes("\\"))
        return null;
    let resolved: URL;
    try {
        resolved = new URL(target, PLACEHOLDER_ORIGIN);
    } catch {
        return null;
    }
    if (resolved.origin !== PLACEHOLDER_ORIGIN || /^[\\/]{2}/.test(resolved.pathname)) return null;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
