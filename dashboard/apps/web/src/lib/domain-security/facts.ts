/**
 * What an audit learned about a domain from public data, before it is judged.
 *
 * Collecting (`collect.ts`) asks DNS, RDAP and the domain's own web server and
 * fills this in; judging (`evaluate.ts`) reads only this. Kept apart so every
 * verdict is tested from a fixture with no network at all.
 *
 * `null` always means "could not find out" - a resolver that did not answer, a
 * registry with no RDAP - and is judged as unknown, never as missing. A missing
 * record is an empty list.
 */

import type { SpfWalk } from "./records";

export interface MxHost {
    readonly priority: number;
    /** "" for the null MX (RFC 7505), which a resolver gives as the root. */
    readonly exchange: string;
}

export interface DkimFound {
    readonly selector: string;
    readonly text: string;
    /** The key's size in bits, null when it could not be read. */
    readonly bits: number | null;
}

export type MtaStsFetch =
    | { readonly status: "ok"; readonly text: string }
    | { readonly status: "missing" }
    | { readonly status: "unreachable" };

export interface CaaEntry {
    readonly flags: number;
    readonly tag: string;
    readonly value: string;
}

export interface NameServer {
    readonly name: string;
    readonly addresses: readonly string[];
}

export interface RegistrationFacts {
    readonly expiresAt: string | null;
    /** RDAP status values, lower case ("client transfer prohibited"). */
    readonly statuses: readonly string[];
    readonly registrar: string | null;
    /** Whether the registrant's details are withheld; null when RDAP does not say. */
    readonly registrantRedacted: boolean | null;
}

export interface CertificateFacts {
    readonly issuer: string;
    readonly validTo: string;
    /** Whether the chain verified against the system's roots for this name. */
    readonly trusted: boolean;
    /** Why it did not, in the TLS library's words. */
    readonly error: string | null;
}

export interface WebFacts {
    /** null when nothing answered on 443. */
    readonly certificate: CertificateFacts | null;
    readonly httpsError: string | null;
    /** The protocol a modern client negotiated, e.g. "TLSv1.3". */
    readonly protocol: string | null;
    /** The legacy version a server still accepted, null when it refused both
     *  1.0 and 1.1, undefined when that could not be asked. */
    readonly legacyProtocol: string | null | undefined;
    /** Whether plain HTTP sends visitors to HTTPS; null when it did not answer. */
    readonly httpRedirects: boolean | null;
    /** The response headers of the HTTPS front page, names lower case. */
    readonly headers: Readonly<Record<string, string>> | null;
    readonly securityTxt: { readonly status: "ok"; readonly text: string } | { readonly status: "missing" } | null;
    /** Whether Polaris's own edge serves this name, so headers are Polaris's to set. */
    readonly servedByPolaris: boolean;
}

/** What Polaris knows of the domain on its own side, which changes the advice. */
export interface DomainContext {
    /** Polaris orders certificates for names here, so a CAA must allow its CA. */
    readonly polarisIssues: boolean;
    /** A deploy or owner zone: a wildcard here is Polaris's own and intended. */
    readonly polarisZone: boolean;
    /** The SPF a Polaris mail server on this domain needs, when there is one. */
    readonly mailServerSpf: string | null;
    /** The address Polaris reads DMARC reports at for this domain, when it does. */
    readonly reportAddress: string | null;
    /** The DS record the DNS host gives for its signing key, when it is known. */
    readonly dsRecord: string | null;
}

export interface DomainFacts {
    readonly domain: string;
    readonly mx: readonly MxHost[] | null;
    /** Every TXT string at the domain itself. */
    readonly apexTxt: readonly string[] | null;
    readonly spfWalk: SpfWalk | null;
    readonly dmarcTxt: readonly string[] | null;
    /** Report hosts outside the domain and whether each authorized the reports. */
    readonly ruaAuthorization: Readonly<Record<string, boolean | null>>;
    readonly dkim: readonly DkimFound[] | null;
    readonly dkimSelectorsTried: readonly string[];
    readonly mtaStsTxt: readonly string[] | null;
    readonly mtaStsPolicy: MtaStsFetch | null;
    readonly tlsRptTxt: readonly string[] | null;
    readonly bimiTxt: readonly string[] | null;
    readonly dnssec: { readonly ds: boolean | null; readonly dnskey: boolean | null; readonly validated: boolean | null };
    readonly caa: readonly CaaEntry[] | null;
    readonly ns: readonly NameServer[] | null;
    /** Each name server asked for a zone transfer: true when it gave one. */
    readonly axfr: readonly { readonly server: string; readonly open: boolean | null }[];
    readonly dangling: readonly { readonly name: string; readonly target: string }[];
    /** How many aliases were looked at for dangling targets. */
    readonly danglingChecked: number;
    readonly wildcard: boolean | null;
    readonly registration: RegistrationFacts | null;
    /** null when the domain has no address, so there is no site to look at. */
    readonly web: WebFacts | null;
    readonly context: DomainContext;
}
