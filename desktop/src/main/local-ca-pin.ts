/**
 * Accept the same Polaris's own local certificate on its proven local address,
 * with nothing installed by the person. Pure, with no `electron` import, so the
 * decision is tested without a runtime.
 *
 * A Polaris's local names (polaris.local, its LAN IP) carry a certificate from
 * the instance's own local CA, which this computer does not trust unless someone
 * installed it. `GET /api/instance` publishes that CA's SHA-256, and the client
 * learns it only over the usual address (https, trusted by the system). Here a
 * chain is accepted only when all of this holds:
 *
 * - the usual address is https and the host asked for is one of the instance's
 *   other addresses (never the usual one, never anything else);
 * - Chromium's only complaint is the unknown authority (-202);
 * - the leaf names that host, every certificate is in date, and each one is
 *   signed by the next, up to a CA certificate whose SHA-256 is the pin.
 *
 * A LAN attacker answering polaris.local cannot present such a chain without the
 * instance's CA key, so the relay attack that ruled out "trust what was served
 * during the proof" does not apply: the chain itself names this instance.
 */

import { isIP } from "node:net";
import { X509Certificate } from "node:crypto";
import type { InstanceRecord } from "../../../dashboard/packages/core/src/instance-fallback";

/** Chromium's `ERR_CERT_AUTHORITY_INVALID`: a chain to a root this computer does not trust. */
export const AUTHORITY_INVALID = -202;
/** `setCertificateVerifyProc` answers: accept, or leave it to Chromium's own verdict. */
export const ACCEPT = 0;
export const USE_CHROMIUM = -3;

/** Where the pin applies, for the one server the app is on. */
export interface PinScope {
    /** Hostnames of the instance's other addresses, lowercase, without brackets. */
    readonly hosts: readonly string[];
    /** Lowercase hex SHA-256 of the local CA certificate(s). */
    readonly pins: readonly string[];
}

/** The shape of Electron's `Certificate` this reads: PEM and its issuer, up the chain. */
export interface ChainLink {
    readonly data: string;
    readonly issuerCert?: ChainLink | null;
}

/** What `setCertificateVerifyProc` is asked, as far as this decision needs it. */
export interface VerifyRequest {
    readonly hostname: string;
    readonly errorCode: number;
    readonly certificate: ChainLink;
}

const MAX_CHAIN = 6;

function bareHost(hostname: string): string {
    return hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

/**
 * The scope for `primary` given what was learned over it, or null when nothing
 * may be accepted: no record, no published CA, or a usual address that is not
 * https (a pin learned over plain HTTP proves nothing).
 */
export function pinScope(primary: string | null, record: InstanceRecord | null): PinScope | null {
    if (!primary || !record?.localCaSha256?.length) return null;
    let primaryHost: string;
    try {
        const url = new URL(primary);
        if (url.protocol !== "https:") return null;
        primaryHost = bareHost(url.hostname);
    } catch {
        return null;
    }
    const hosts = new Set<string>();
    for (const address of record.addresses) {
        try {
            const url = new URL(address);
            const host = bareHost(url.hostname);
            if (url.protocol === "https:" && host && host !== primaryHost) hosts.add(host);
        } catch {
            // Not an address; nothing to pin for it.
        }
    }
    if (hosts.size === 0) return null;
    return { hosts: [...hosts], pins: [...record.localCaSha256] };
}

function sha256(cert: X509Certificate): string {
    return cert.fingerprint256.replaceAll(":", "").toLowerCase();
}

function inDate(cert: X509Certificate, now: number): boolean {
    const from = Date.parse(cert.validFrom);
    const to = Date.parse(cert.validTo);
    return Number.isFinite(from) && Number.isFinite(to) && from <= now && now <= to;
}

function namesHost(leaf: X509Certificate, hostname: string): boolean {
    return isIP(hostname) ? leaf.checkIP(hostname) !== undefined : leaf.checkHost(hostname) !== undefined;
}

/**
 * Whether `chain` is a certificate for `hostname` signed, link by link, up to a
 * CA whose SHA-256 is one of `pins`. Signatures are checked here, not taken from
 * the chain's own claims: a leaf of someone else's that merely lists the real CA
 * as its issuer fails.
 */
export function chainEndsInPin(chain: ChainLink, hostname: string, pins: readonly string[], now = Date.now()): boolean {
    const certs: X509Certificate[] = [];
    let link: ChainLink | null | undefined = chain;
    try {
        while (link && certs.length < MAX_CHAIN) {
            const cert = new X509Certificate(link.data);
            if (certs.length > 0 && sha256(certs[certs.length - 1]!) === sha256(cert)) break;
            certs.push(cert);
            link = link.issuerCert;
        }
    } catch {
        return false;
    }
    const anchor = certs.findIndex((cert, index) => index > 0 && pins.includes(sha256(cert)));
    if (anchor < 1) return false;
    const leaf = certs[0]!;
    if (leaf.ca || !namesHost(leaf, bareHost(hostname))) return false;
    for (let index = 0; index <= anchor; index++) {
        const cert = certs[index]!;
        if (!inDate(cert, now)) return false;
        if (index === anchor) break;
        const issuer = certs[index + 1]!;
        if (!issuer.ca || !cert.checkIssued(issuer) || !cert.verify(issuer.publicKey)) return false;
    }
    return true;
}

/**
 * The answer for one verification: accept only a pinned chain on an in-scope
 * host whose sole fault is the unknown authority; everything else - a trusted
 * chain included - keeps Chromium's own verdict.
 */
export function verifyDecision(request: VerifyRequest, scope: PinScope | null, now = Date.now()): number {
    if (!scope || request.errorCode !== AUTHORITY_INVALID) return USE_CHROMIUM;
    const host = bareHost(request.hostname);
    if (!scope.hosts.includes(host)) return USE_CHROMIUM;
    return chainEndsInPin(request.certificate, host, scope.pins, now) ? ACCEPT : USE_CHROMIUM;
}
