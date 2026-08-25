/**
 * One wildcard certificate for the base every free subdomain is minted under, so a new
 * service is served over trusted HTTPS the moment it has a name.
 *
 * The edge asks Let's Encrypt for a certificate per hostname over the HTTP-01
 * challenge. That works, but it happens the first time each name is used: until the
 * order completes the edge answers with its own self-signed default, and the browser
 * says the site is not secure. A wildcard removes the wait entirely - `*.plr.example`
 * is issued once and covers every name minted under it, including ones that do not
 * exist yet.
 *
 * Let's Encrypt only issues a wildcard against the DNS-01 challenge, which is why this
 * lives here rather than in the edge's configuration: DNS-01 needs to write a TXT
 * record in the zone, Polaris already holds a Cloudflare token that can, and handing
 * that token to the edge would mean rebuilding the container that serves the dashboard
 * every time it changed. So Polaris orders the certificate and writes it into the
 * dynamic configuration the edge already reads - the same seam the local CA leaf uses.
 *
 * The per-hostname resolver stays configured. A route whose name the wildcard does not
 * cover still gets its own certificate exactly as before, and an instance with no
 * Cloudflare token behaves precisely as it does today.
 */

import { join } from "node:path";
import { loadEnv } from "@polaris/config";
import { X509Certificate } from "node:crypto";
import { deployBase } from "@/lib/domain-service";
import { getSetting, setSetting } from "@/lib/setting-store";
import { mkdir, readFile } from "node:fs/promises";
import { dynamicDir, writeDynamicFile } from "@/lib/traefik-dynamic";
import { loadCloudflareToken } from "@/lib/integrations/cloudflare-account-service";
import {
    deleteDnsRecord,
    findTxtRecords,
    resolveZoneForHostname,
    upsertTxtRecord
} from "@/lib/integrations/cloudflare-api";

/** Where the certificate and its key are written for the edge to read. */
const DYNAMIC_CRT = "polaris-wildcard.crt";
const DYNAMIC_KEY = "polaris-wildcard.key";
/** Its own file rather than an edit of the local CA's: the edge merges every file in
 *  the directory, and two files each declaring a default certificate would fight. This
 *  one only ever adds to `tls.certificates`, which merges cleanly. */
const DYNAMIC_TLS = "polaris-wildcard.yml";

/** The ACME account key, kept so renewals use the same registration. */
const ACCOUNT_KEY_SETTING = "tls.wildcard.accountKey";
/** The base the stored certificate was issued for, so a changed deploy base re-orders
 *  rather than serving a certificate for a name nobody uses any more. */
const ISSUED_FOR_SETTING = "tls.wildcard.issuedFor";

/**
 * Renew this long before expiry. Let's Encrypt issues for 90 days and recommends
 * renewing at 30 left; the window is generous because a failed attempt should have
 * many more chances before anything is actually at risk.
 */
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

/** How long to wait for the challenge record to be visible before asking Let's Encrypt
 *  to look. Cloudflare publishes in seconds, but the authoritative answer has to have
 *  propagated to the resolver the validation comes from. */
const DNS_SETTLE_MS = 20_000;

export interface WildcardCertState {
    /** The base it covers (`plr.example.com`), or null when there is none. */
    readonly base: string | null;
    /** When the current certificate expires, or null when there is none. */
    readonly expiresAt: Date | null;
    /** Why there is no wildcard, when there is not one and could be. */
    readonly reason: string | null;
}

/** What is on disk right now, without ordering anything. */
export async function wildcardCertState(): Promise<WildcardCertState> {
    const base = await getSetting(ISSUED_FOR_SETTING);
    const cert = await readStoredCert();
    return {
        base: cert ? base : null,
        expiresAt: cert ? new Date(cert.validTo) : null,
        reason: null
    };
}

/** The stored certificate, parsed, or null when there is none to read. */
async function readStoredCert(): Promise<X509Certificate | null> {
    try {
        const pem = await readFile(join(dynamicDir(), DYNAMIC_CRT), "utf8");
        return new X509Certificate(pem);
    } catch {
        return null;
    }
}

/**
 * Order or renew the wildcard, and publish it to the edge.
 *
 * Idempotent and safe to call on a schedule: it returns without doing anything when a
 * current certificate already covers the base. Every reason not to proceed is an
 * ordinary outcome rather than an error - no Cloudflare token, no deploy base, a base
 * that is not in an account the token reaches - because none of them is a fault, they
 * are just instances that have not opted into this.
 */
export async function ensureWildcardCertificate(): Promise<WildcardCertState> {
    const base = (await deployBase()).trim().toLowerCase();
    if (!base || base.split(".").length < 2) {
        return { base: null, expiresAt: null, reason: "no deploy domain is configured" };
    }
    // A magic-DNS base (sslip.io and friends) is nobody's zone here, and its names
    // encode an address rather than being minted under a domain. Not special-cased:
    // resolving the zone below is the real gate, and a base this token cannot reach
    // falls out there with a reason worth reading.
    const token = await loadCloudflareToken();
    if (!token) return { base: null, expiresAt: null, reason: "no Cloudflare token is connected" };

    const stored = await readStoredCert();
    const issuedFor = await getSetting(ISSUED_FOR_SETTING);
    const current =
        stored !== null &&
        issuedFor === base &&
        new Date(stored.validTo).getTime() - Date.now() > RENEW_BEFORE_MS;
    if (current) {
        return { base, expiresAt: new Date(stored.validTo), reason: null };
    }

    try {
        const { certificate, key } = await orderWildcard(base, token);
        await publish(certificate, key);
        await setSetting(ISSUED_FOR_SETTING, base);
        return {
            base,
            expiresAt: new Date(new X509Certificate(certificate).validTo),
            reason: null
        };
    } catch (caught) {
        const reason = caught instanceof Error ? caught.message : "the order failed";
        console.error("polaris: could not obtain the wildcard certificate:", reason);
        // The old certificate, if there is one, keeps serving: a failed renewal is not a
        // reason to stop presenting one that is still valid.
        return { base, expiresAt: stored ? new Date(stored.validTo) : null, reason };
    }
}

/** Run the ACME order for `*.base` (and the base itself, which a wildcard does not
 *  cover) against the DNS-01 challenge. */
async function orderWildcard(
    base: string,
    token: string
): Promise<{ certificate: string; key: string }> {
    // Imported here rather than at module load: this is a heavy dependency used by one
    // scheduled job, and every other request through this file should not pay for it.
    const acme = await import("acme-client");
    const zone = await resolveZoneForHostname(token, base);
    const accountKey = await accountKeyPem(acme);

    const client = new acme.Client({
        directoryUrl: acme.directory.letsencrypt.production,
        accountKey
    });

    const [key, csr] = await acme.crypto.createCsr({ altNames: [`*.${base}`, base] });

    const certificate = await client.auto({
        csr,
        email: loadEnv().POLARIS_ACME_EMAIL || undefined,
        termsOfServiceAgreed: true,
        challengePriority: ["dns-01"],
        challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
            if (challenge.type !== "dns-01")
                throw new Error("only the DNS challenge can issue a wildcard");
            await upsertTxtRecord(token, zone.id, `_acme-challenge.${base}`, keyAuthorization);
            // Both names on the order answer at the same record, so this is written
            // twice with different values. Cloudflare keeps them as separate TXT
            // records at that name, which is what the protocol expects.
            await new Promise((resolve) => setTimeout(resolve, DNS_SETTLE_MS));
        },
        challengeRemoveFn: async () => {
            // Best effort: a leftover challenge record is harmless, and failing the
            // whole order because the cleanup did not answer would be worse.
            try {
                for (const record of await findTxtRecords(
                    token,
                    zone.id,
                    `_acme-challenge.${base}`
                )) {
                    await deleteDnsRecord(token, zone.id, record.id);
                }
            } catch {
                // Nothing to do about it here; the next order overwrites them.
            }
        }
    });

    return { certificate: certificate.toString(), key: key.toString() };
}

/** The ACME account key, generated once and kept, so renewals reuse the registration
 *  rather than making a new account against the rate limit every time. */
async function accountKeyPem(acme: typeof import("acme-client")): Promise<string> {
    const stored = await getSetting(ACCOUNT_KEY_SETTING);
    if (stored) return stored;
    const created = (await acme.crypto.createPrivateKey()).toString();
    await setSetting(ACCOUNT_KEY_SETTING, created);
    return created;
}

/**
 * Write the certificate where the edge reads it.
 *
 * Only `tls.certificates`, never a default: the edge picks by SNI, so this covers every
 * name under the base and leaves everything else - the LAN names on the local CA, a
 * hostname with its own certificate - exactly as it was.
 */
async function publish(certificate: string, key: string): Promise<void> {
    const dyn = dynamicDir();
    const crtPath = join(dyn, DYNAMIC_CRT);
    const keyPath = join(dyn, DYNAMIC_KEY);
    await mkdir(dyn, { recursive: true });
    await writeDynamicFile(DYNAMIC_CRT, certificate);
    await writeDynamicFile(DYNAMIC_KEY, key, { mode: 0o600 });
    const tls = [
        "tls:",
        "  certificates:",
        `    - certFile: ${crtPath}`,
        `      keyFile: ${keyPath}`,
        ""
    ].join("\n");
    await writeDynamicFile(DYNAMIC_TLS, tls);
}

/** Check daily, which is often enough for a 90-day certificate renewed at 30 days
 *  left and rare enough to be invisible. */
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const FIRST_PASS_MS = 60_000;

let started = false;

/** Keep the wildcard current. Self-guarding: a failed pass only logs, and the previous
 *  certificate keeps serving until a later one succeeds. */
export function startWildcardCertRenewal(): void {
    if (started) return;
    started = true;
    const tick = (): void => {
        void ensureWildcardCertificate().catch((error: unknown) =>
            console.error("polaris: the wildcard certificate check failed:", error)
        );
    };
    setTimeout(tick, FIRST_PASS_MS).unref();
    setInterval(tick, CHECK_EVERY_MS).unref();
}
