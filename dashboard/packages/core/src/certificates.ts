/**
 * Judging a certificate somebody supplied for a hostname.
 *
 * An operator can hand Polaris their own certificate for a domain - one issued by a
 * CA their company already pays for, one covering names Polaris cannot order for, one
 * from an internal PKI their devices already trust. That has to be served in place of
 * the managed one, but only while it is actually better than what would otherwise be
 * presented: a certificate that has lapsed, or that is not for this name, would turn a
 * working site into a browser warning, and doing that silently because somebody
 * uploaded the wrong file is the failure worth designing against.
 *
 * So the rule is not "prefer the operator's" but "prefer the operator's while it
 * serves". Everything here is a property of the certificate itself, decided without a
 * network call: whether it parses, whether it covers the name, and whether it is
 * inside its validity window. Whether the issuer is one the visitor's browser trusts
 * is deliberately NOT judged here - an internal CA is a legitimate reason to upload
 * one, and Polaris has no way to know what the people visiting this service trust.
 */

/** The shape read off a parsed certificate, so the rules below are testable without
 *  a crypto implementation behind them. */
export interface CertificateFacts {
    /** Every name the certificate is valid for: its subject CN and its SANs. */
    readonly names: readonly string[];
    readonly validFrom: Date;
    readonly validTo: Date;
}

export type CertificateVerdict =
    | { readonly usable: true; readonly warning: string | null }
    | { readonly usable: false; readonly reason: string };

/** How long before expiry the operator is warned, while it is still served. */
const EXPIRY_WARNING_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Whether one of the names on a certificate covers `hostname`.
 *
 * A wildcard matches exactly one label and only the leftmost one, which is what the
 * TLS rules say and what browsers enforce: `*.example.com` covers `app.example.com`
 * and neither `example.com` nor `a.b.example.com`. Getting this wrong in the
 * permissive direction would serve a certificate the browser then rejects, which is
 * the outcome this whole module exists to avoid.
 */
export function certificateCoversHost(names: readonly string[], hostname: string): boolean {
    const host = hostname.trim().toLowerCase().replace(/\.$/, "");
    if (!host) return false;
    return names.some((raw) => {
        const name = raw.trim().toLowerCase().replace(/\.$/, "");
        if (!name) return false;
        if (name === host) return true;
        if (!name.startsWith("*.")) return false;
        const suffix = name.slice(1);
        if (!host.endsWith(suffix)) return false;
        // Exactly one label in front of the suffix, and it must not be empty.
        const label = host.slice(0, host.length - suffix.length);
        return label.length > 0 && !label.includes(".");
    });
}

/**
 * Whether this certificate should be served for this hostname, and what to say about
 * it either way.
 *
 * `now` is passed in rather than read, so the boundary cases are testable rather than
 * approximated.
 */
export function judgeCertificate(
    facts: CertificateFacts,
    hostname: string,
    now: Date
): CertificateVerdict {
    if (!certificateCoversHost(facts.names, hostname)) {
        const listed = facts.names.length > 0 ? facts.names.join(", ") : "no names at all";
        return { usable: false, reason: `This certificate is for ${listed}, not ${hostname}.` };
    }
    if (now < facts.validFrom) {
        return { usable: false, reason: "This certificate is not valid yet." };
    }
    if (now >= facts.validTo) {
        return { usable: false, reason: "This certificate has expired." };
    }
    const left = facts.validTo.getTime() - now.getTime();
    if (left < EXPIRY_WARNING_MS) {
        const days = Math.max(1, Math.round(left / (24 * 60 * 60 * 1000)));
        return { usable: true, warning: `This certificate expires in ${days} day${days === 1 ? "" : "s"}.` };
    }
    return { usable: true, warning: null };
}
