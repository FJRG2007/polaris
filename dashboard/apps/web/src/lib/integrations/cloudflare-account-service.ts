/**
 * The Cloudflare API connection. Polaris asks Cloudflare for two unrelated things -
 * writing a zone's DNS records, and creating named tunnels - and they need different
 * permissions: the first is zone-scoped, the second account-scoped. So there are two
 * token slots, and one token carrying both sets fills them both.
 *
 * Two slots rather than one because either credential alone is a complete, useful
 * setup, and a single slot makes them evict each other: connecting a DNS token from
 * the guided setup would take working tunnels offline, which is a surprising price
 * for pointing a domain. An operator who prefers not to hand a DNS tool any tunnel
 * access can also just fill one.
 *
 * Tokens are credentials, stored envelope-encrypted at rest with the master key
 * (never in plaintext). The account id and name belong to the tunnel slot, because
 * that is the only one an account is needed - or askable - for.
 *
 * This is separate from the marketplace connector token (a server-wide tunnel run by
 * tunnel-service): that grants no API access, these do. Config lives in the Setting
 * table, so no schema change is needed.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import type { CloudflareTokenScope } from "./cloudflare-token-link";
import { listAccounts, listZones, verifyToken, type CfAccount, type CfZone } from "./cloudflare-api";

const KEYS = {
    // The original key, kept as the tunnel slot so installs that connected a token
    // before the split keep their tunnels working without a migration.
    tunnelToken: "integrations.cloudflare.apiToken",
    dnsToken: "integrations.cloudflare.dnsToken",
    accountId: "integrations.cloudflare.accountId",
    accountName: "integrations.cloudflare.accountName"
} as const;

async function getSetting(key: string): Promise<string | null> {
    const row = await prisma.setting.findUnique({ where: { key }, select: { value: true } });
    return row?.value ?? null;
}

async function setSetting(key: string, value: string | null): Promise<void> {
    if (value === null) {
        await prisma.setting.deleteMany({ where: { key } });
        return;
    }
    await prisma.setting.upsert({ where: { key }, create: { key, value, scope: "global" }, update: { value } });
}

function storeToken(key: string, token: string): Promise<void> {
    const blob = encryptSecret(token, loadEnv().POLARIS_MASTER_KEY);
    return setSetting(
        key,
        JSON.stringify({ c: blob.ciphertext.toString("base64"), n: blob.nonce.toString("base64"), k: blob.keyId })
    );
}

async function readToken(key: string): Promise<string | null> {
    const raw = await getSetting(key);
    if (!raw) return null;
    try {
        const { c, n, k } = JSON.parse(raw) as { c: string; n: string; k: string };
        return decryptSecret(
            { ciphertext: Buffer.from(c, "base64"), nonce: Buffer.from(n, "base64"), keyId: k },
            loadEnv().POLARIS_MASTER_KEY
        );
    } catch {
        return null;
    }
}

/**
 * The token to write DNS records with, or null when none. Falls back to the tunnel
 * slot because a token carrying both permission sets is stored once, in that slot -
 * and because every install predating the split has its only token there.
 */
export function loadCloudflareToken(): Promise<string | null> {
    return readToken(KEYS.dnsToken).then((dns) => dns ?? readToken(KEYS.tunnelToken));
}

/** The token to create tunnels with, or null when none. Never the DNS slot: that one
 *  is not required to reach an account, so it cannot be assumed to. */
export function loadCloudflareTunnelToken(): Promise<string | null> {
    return readToken(KEYS.tunnelToken);
}

export interface CloudflareAccountStatus {
    /** A tunnel token and an account: named tunnels can be provisioned. */
    connected: boolean;
    /** A token that can write DNS records, from either slot. */
    dnsReady: boolean;
    /** Which slots hold a token, so the panel can offer and revoke them one by one. */
    slots: { dns: boolean; tunnel: boolean };
    accountId: string | null;
    accountName: string | null;
}

/** What the connected tokens can do, for the UI. */
export async function getCloudflareAccountStatus(): Promise<CloudflareAccountStatus> {
    const [dns, tunnel, accountId, accountName] = await Promise.all([
        readToken(KEYS.dnsToken),
        readToken(KEYS.tunnelToken),
        getSetting(KEYS.accountId),
        getSetting(KEYS.accountName)
    ]);
    return {
        connected: Boolean(tunnel && accountId),
        dnsReady: Boolean(dns || tunnel),
        slots: { dns: Boolean(dns), tunnel: Boolean(tunnel) },
        accountId,
        accountName
    };
}

/**
 * The tunnel credentials, or throw a clear error if none - the guard every automated
 * tunnel path calls before touching the Cloudflare API. A DNS token alone never
 * satisfies it: writing records proves nothing about reaching an account.
 */
export async function requireCloudflareAccount(): Promise<{ token: string; accountId: string }> {
    const [token, accountId] = await Promise.all([loadCloudflareTunnelToken(), getSetting(KEYS.accountId)]);
    if (!token || !accountId) {
        throw new Error(
            "Connect a Cloudflare token with Account - Cloudflare Tunnel: Edit under Integrations to create tunnels."
        );
    }
    return { token, accountId };
}

export interface ConnectResult {
    connected: boolean;
    accounts: CfAccount[];
    accountName?: string;
    /** Which slots the token ended up in, so the panel can say what it gained. */
    stored: CloudflareTokenScope[];
}

/** Write the tunnel slot and the account it acts on. */
async function storeTunnel(token: string, account: CfAccount): Promise<void> {
    await storeToken(KEYS.tunnelToken, token);
    await setSetting(KEYS.accountId, account.id);
    await setSetting(KEYS.accountName, account.name);
}

/**
 * Validate a Cloudflare API token and connect it for `scope`.
 *
 * `dns` needs no account at all - listing accounts takes an account-scoped
 * permission that a DNS token has no reason to carry, so the token that can write
 * every record is exactly the one that cannot answer that call. It is checked
 * against the zones it reaches instead.
 *
 * `tunnel` and `all` do need one, and a token reaching several cannot be resolved
 * here: the caller passes the chosen account back, and the accounts are returned so
 * the UI can ask. An `all` token that turns out to reach no account is still useful
 * for DNS, so it is kept for that rather than refused outright.
 */
export async function connectCloudflareToken(
    token: string,
    options: { scope: CloudflareTokenScope; accountId?: string } = { scope: "all" }
): Promise<ConnectResult> {
    const trimmed = token.trim();
    if (!trimmed) throw new Error("Paste your Cloudflare API token");
    await verifyToken(trimmed);
    const { scope, accountId } = options;

    if (scope === "dns") {
        await requireZones(trimmed);
        await storeToken(KEYS.dnsToken, trimmed);
        return { connected: true, accounts: [], stored: ["dns"] };
    }

    // Cloudflare answers a zone-scoped token with an empty list here, but it may also
    // refuse the call outright, and a refusal says the same thing: no account.
    const accounts = await listAccounts(trimmed).catch(() => [] as CfAccount[]);
    if (accounts.length === 0) {
        if (scope === "tunnel") {
            throw new Error(
                "The token reaches no Cloudflare account, so it cannot create tunnels. It needs Account - Cloudflare Tunnel: Edit."
            );
        }
        // Meant to carry both and carries one. Kept for DNS, and said so, rather than
        // rejected - the operator would otherwise be told a working token is useless.
        await requireZones(trimmed);
        await storeToken(KEYS.dnsToken, trimmed);
        return { connected: true, accounts: [], stored: ["dns"] };
    }

    const chosen = accountId
        ? accounts.find((account) => account.id === accountId)
        : accounts.length === 1
          ? accounts[0]
          : undefined;
    if (!chosen) {
        // Several accounts and none chosen yet: store nothing, let the UI pick.
        return { connected: false, accounts, stored: [] };
    }

    await storeTunnel(trimmed, chosen);
    // An `all` token fills the DNS slot too, so the two capabilities do not silently
    // depend on each other: revoking one later leaves the other exactly as it was.
    if (scope === "all") await storeToken(KEYS.dnsToken, trimmed);
    return {
        connected: true,
        accounts,
        accountName: chosen.name,
        stored: scope === "all" ? ["dns", "tunnel"] : ["tunnel"]
    };
}

/** Refuse a token that cannot see a single zone, which is all writing records needs. */
async function requireZones(token: string): Promise<void> {
    const zones = await listZones(token).catch(() => [] as CfZone[]);
    if (zones.length === 0) {
        throw new Error(
            "The token reaches no domain. It needs Zone - DNS: Edit and Zone - Zone: Read on the domain you are setting up."
        );
    }
}

/**
 * Forget one slot, or both. Never touches tunnels already provisioned - they keep
 * running on the connector token they were created with; what is lost is Polaris's
 * ability to create or change more of them.
 */
export async function disconnectCloudflareToken(scope: CloudflareTokenScope = "all"): Promise<void> {
    if (scope !== "tunnel") await setSetting(KEYS.dnsToken, null);
    if (scope !== "dns") {
        await Promise.all([
            setSetting(KEYS.tunnelToken, null),
            setSetting(KEYS.accountId, null),
            setSetting(KEYS.accountName, null)
        ]);
    }
}

/** The zones the connected token can manage, for display. */
export async function listCloudflareZones(): Promise<CfZone[]> {
    const token = await loadCloudflareToken();
    if (!token) return [];
    return listZones(token);
}
