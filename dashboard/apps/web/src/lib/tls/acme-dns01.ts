/**
 * One ACME order proven over DNS-01, for any set of names a provider can answer.
 *
 * Let's Encrypt only issues a wildcard against DNS-01, and a wildcard order always
 * carries two names that answer at the same record: `*.example.com` and
 * `example.com` both publish at `_acme-challenge.example.com`, with different
 * values, at the same time - the client validates every authorization of an order
 * in parallel. So each answer is its own record, added beside the other and removed
 * by its own handle. Rewriting one record in place, or clearing every record at
 * the name when one validation finishes, takes away the answer the other is still
 * being checked against.
 */

import { loadEnv } from "@polaris/config";
import type { Dns01Provider } from "./dns01";
import { getSetting, setSetting } from "@/lib/setting-store";

/** The ACME account key, kept so every order and renewal uses one registration.
 *  The key the deploy-base wildcard has always used, so that account carries on. */
const ACCOUNT_KEY_SETTING = "tls.wildcard.accountKey";

/** How long to wait for a challenge record to be visible before asking Let's Encrypt
 *  to look. Cloudflare publishes in seconds, but the authoritative answer has to have
 *  propagated to the resolver the validation comes from. */
const DNS_SETTLE_MS = 20_000;

/** The record an identifier's answer is published at. A wildcard authorization
 *  names its base, so both halves of a wildcard order land on the same one. */
export function challengeRecordName(identifier: string): string {
    return `_acme-challenge.${identifier.replace(/^\*\./, "")}`;
}

export interface Dns01Order {
    /** Every name the certificate covers - `*.example.com` and `example.com` for a
     *  wildcard, since a wildcard does not cover its own base. */
    readonly names: readonly string[];
    readonly provider: Dns01Provider;
    /** Overridden by tests; the real wait is `DNS_SETTLE_MS`. */
    readonly settleMs?: number;
    /** Overridden by tests; production Let's Encrypt otherwise. */
    readonly directoryUrl?: string;
}

/** Order a certificate, returning it and its private key as PEM. */
export async function orderDns01Certificate(
    order: Dns01Order
): Promise<{ certificate: string; key: string }> {
    // Imported here rather than at module load: this is a heavy dependency used by a
    // scheduled job, and nothing else that imports this file should pay for it.
    const acme = await import("acme-client");
    const accountKey = await accountKeyPem(acme);
    const client = new acme.Client({
        directoryUrl: order.directoryUrl ?? acme.directory.letsencrypt.production,
        accountKey
    });
    const [key, csr] = await acme.crypto.createCsr({ altNames: [...order.names] });
    const settle = order.settleMs ?? DNS_SETTLE_MS;
    // One handle per published answer, keyed by the identifier and the answer so
    // the two halves of a wildcard order never touch each other's record.
    const published = new Map<string, string>();
    const certificate = await client.auto({
        csr,
        email: loadEnv().POLARIS_ACME_EMAIL || undefined,
        termsOfServiceAgreed: true,
        challengePriority: ["dns-01"],
        challengeCreateFn: async (authz, challenge, keyAuthorization) => {
            if (challenge.type !== "dns-01")
                throw new Error("only the DNS challenge can issue this certificate");
            const handle = await order.provider.present(
                challengeRecordName(authz.identifier.value),
                keyAuthorization
            );
            published.set(`${authz.identifier.value} ${keyAuthorization}`, handle);
            await new Promise((resolve) => setTimeout(resolve, settle));
        },
        challengeRemoveFn: async (authz, _challenge, keyAuthorization) => {
            const slot = `${authz.identifier.value} ${keyAuthorization}`;
            const handle = published.get(slot);
            if (!handle) return;
            published.delete(slot);
            // Best effort: a leftover challenge record is harmless, and failing a
            // certificate that was issued because the cleanup did not answer is worse.
            await order.provider.cleanup(handle).catch(() => undefined);
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
