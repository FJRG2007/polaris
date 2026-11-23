/**
 * Stands in for account-key-client.ts in sealed-browser.test.ts: the account
 * key's HPKE pair, from the key the test handed this page, instead of from an
 * unlocked device lock (whose ceremonies have their own tests).
 */

import * as account from "@polaris/chat-crypto/account-key";

export async function deviceAccountHpke(): Promise<{ hpkePublicKey: Uint8Array; hpkePrivateKey: CryptoKey } | null> {
    const given = (globalThis as { accountKey?: number[] }).accountKey;
    if (!given) return null;
    const key = Uint8Array.from(given);
    const [published, pair] = await Promise.all([account.accountPublicKeys(key), account.accountHpkeKeyPair(key)]);
    return { hpkePublicKey: published.hpkePublicKey, hpkePrivateKey: pair.privateKey };
}
