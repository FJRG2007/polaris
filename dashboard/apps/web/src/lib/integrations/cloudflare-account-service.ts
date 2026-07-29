/**
 * The account-level Cloudflare connection that powers automated named tunnels.
 * An operator connects one API token (Account - Cloudflare Tunnel: Edit, Zone -
 * DNS: Edit, Zone: Read) once here; per-app provisioning then reuses it to create
 * tunnels and DNS records without any dashboard steps. The token is a credential,
 * stored envelope-encrypted at rest with the master key (never in plaintext); the
 * chosen account id and name are stored alongside for display and API calls.
 *
 * The domains guided setup connects the same token through the same action, so the
 * zone's records can be created without leaving it. That token is scoped to zones
 * alone, which is all writing DNS needs and less than listing accounts requires - so
 * an account is optional here. A token that reaches zones but no account is stored
 * and writes records; named tunnels stay unavailable on it until one carrying the
 * tunnel permission replaces it, which is what `requireCloudflareAccount` enforces.
 *
 * This is separate from the marketplace "Cloudflare Tunnel" connector token (a
 * server-wide tunnel run by tunnel-service): that grants no API access, this one
 * does. Config lives in the Setting table, so no schema change is needed.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { listAccounts, listZones, verifyToken, type CfAccount, type CfZone } from "./cloudflare-api";

const KEYS = {
    token: "integrations.cloudflare.apiToken",
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

function storeToken(token: string): Promise<void> {
    const blob = encryptSecret(token, loadEnv().POLARIS_MASTER_KEY);
    return setSetting(
        KEYS.token,
        JSON.stringify({ c: blob.ciphertext.toString("base64"), n: blob.nonce.toString("base64"), k: blob.keyId })
    );
}

/** Decrypt the stored API token, or null when none/undecryptable. */
export async function loadCloudflareToken(): Promise<string | null> {
    const raw = await getSetting(KEYS.token);
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

export interface CloudflareAccountStatus {
    /** A token and an account: everything, named tunnels included. */
    connected: boolean;
    /** A token, account or not: enough to write DNS records. */
    dnsReady: boolean;
    accountId: string | null;
    accountName: string | null;
}

/** What the connected token can do, for the UI. */
export async function getCloudflareAccountStatus(): Promise<CloudflareAccountStatus> {
    const [token, accountId, accountName] = await Promise.all([
        loadCloudflareToken(),
        getSetting(KEYS.accountId),
        getSetting(KEYS.accountName)
    ]);
    return { connected: Boolean(token && accountId), dnsReady: Boolean(token), accountId, accountName };
}

/**
 * The connected account context, or throw a clear error if none - the guard every
 * automated-provisioning path calls before touching the Cloudflare API.
 */
export async function requireCloudflareAccount(): Promise<{ token: string; accountId: string }> {
    const [token, accountId] = await Promise.all([loadCloudflareToken(), getSetting(KEYS.accountId)]);
    if (!token) throw new Error("Connect a Cloudflare API token under Integrations first");
    if (!accountId) {
        // A DNS-scoped token connected from the domains setup gets this far and no
        // further: it writes records, but tunnels live on the account it cannot see.
        throw new Error(
            "The connected Cloudflare token has no account access. Connect one with Account - Cloudflare Tunnel: Edit under Integrations."
        );
    }
    return { token, accountId };
}

/**
 * Validate an API token and connect it. With no accountId the token must reach
 * exactly one account (auto-selected); when it reaches several, the caller passes
 * the chosen one. Returns the selectable accounts so the UI can prompt on ambiguity.
 *
 * Reaching no account is not a failure. Listing accounts needs an account-scoped
 * permission, and the token the domains setup asks for carries only zone ones - so
 * the token that can create every record the setup lists is exactly the token that
 * cannot answer that call. It is stored against the zones it reaches instead.
 */
export async function connectCloudflareAccount(
    token: string,
    accountId?: string
): Promise<{ connected: boolean; accounts: CfAccount[]; accountName?: string }> {
    const trimmed = token.trim();
    if (!trimmed) throw new Error("Paste your Cloudflare API token");
    await verifyToken(trimmed);
    // Cloudflare answers a zone-scoped token with an empty list on this call, but it
    // may also refuse it outright, and a refusal says the same thing: no account.
    const accounts = await listAccounts(trimmed).catch(() => [] as CfAccount[]);
    if (accounts.length === 0) {
        const zones = await listZones(trimmed).catch(() => [] as CfZone[]);
        if (zones.length === 0) {
            throw new Error(
                "The token reaches no account and no domain. It needs Zone - DNS: Edit and Zone - Zone: Read on the domain you are setting up."
            );
        }
        await storeToken(trimmed);
        // Cleared, not left behind: the account that was chosen belonged to the token
        // being replaced, and pairing it with this one would have every tunnel call
        // aimed at an account this token cannot touch.
        await setSetting(KEYS.accountId, null);
        await setSetting(KEYS.accountName, null);
        return { connected: true, accounts: [] };
    }

    const chosen = accountId ? accounts.find((account) => account.id === accountId) : accounts.length === 1 ? accounts[0] : undefined;
    if (!chosen) {
        // Several accounts and none chosen yet: store nothing, let the UI pick.
        return { connected: false, accounts };
    }

    await storeToken(trimmed);
    await setSetting(KEYS.accountId, chosen.id);
    await setSetting(KEYS.accountName, chosen.name);
    return { connected: true, accounts, accountName: chosen.name };
}

/** Forget the API token and account (does not touch tunnels already provisioned). */
export async function disconnectCloudflareAccount(): Promise<void> {
    await Promise.all([setSetting(KEYS.token, null), setSetting(KEYS.accountId, null), setSetting(KEYS.accountName, null)]);
}

/** The zones the connected token can manage, for display. */
export async function listCloudflareZones(): Promise<CfZone[]> {
    const token = await loadCloudflareToken();
    if (!token) return [];
    return listZones(token);
}
