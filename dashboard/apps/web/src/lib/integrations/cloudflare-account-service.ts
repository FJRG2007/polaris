/**
 * The account-level Cloudflare connection that powers automated named tunnels.
 * An operator connects one API token (Account - Cloudflare Tunnel: Edit, Zone -
 * DNS: Edit, Zone: Read) once here; per-app provisioning then reuses it to create
 * tunnels and DNS records without any dashboard steps. The token is a credential,
 * stored envelope-encrypted at rest with the master key (never in plaintext); the
 * chosen account id and name are stored alongside for display and API calls.
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
    connected: boolean;
    accountId: string | null;
    accountName: string | null;
}

/** Whether an API token + account are connected, for the UI. */
export async function getCloudflareAccountStatus(): Promise<CloudflareAccountStatus> {
    const [token, accountId, accountName] = await Promise.all([
        loadCloudflareToken(),
        getSetting(KEYS.accountId),
        getSetting(KEYS.accountName)
    ]);
    return { connected: Boolean(token && accountId), accountId, accountName };
}

/**
 * The connected account context, or throw a clear error if none - the guard every
 * automated-provisioning path calls before touching the Cloudflare API.
 */
export async function requireCloudflareAccount(): Promise<{ token: string; accountId: string }> {
    const [token, accountId] = await Promise.all([loadCloudflareToken(), getSetting(KEYS.accountId)]);
    if (!token || !accountId) {
        throw new Error("Connect a Cloudflare API token under Integrations first");
    }
    return { token, accountId };
}

/**
 * Validate an API token and connect it. With no accountId the token must reach
 * exactly one account (auto-selected); when it reaches several, the caller passes
 * the chosen one. Returns the selectable accounts so the UI can prompt on ambiguity.
 */
export async function connectCloudflareAccount(
    token: string,
    accountId?: string
): Promise<{ connected: boolean; accounts: CfAccount[]; accountName?: string }> {
    const trimmed = token.trim();
    if (!trimmed) throw new Error("Paste your Cloudflare API token");
    await verifyToken(trimmed);
    const accounts = await listAccounts(trimmed);
    if (accounts.length === 0) throw new Error("The token cannot reach any Cloudflare account");

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
