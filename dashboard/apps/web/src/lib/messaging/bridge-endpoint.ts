/**
 * Resolves how the web reaches the messaging bridge and the shared secrets it
 * authenticates with. Two modes, env taking precedence:
 *
 *  1. Static env (MESSAGING_BRIDGE_URL / MESSAGING_BRIDGE_TOKEN / MESSAGING_INGEST_KEY)
 *     for operators who run their own bridge outside the marketplace.
 *  2. A marketplace-installed bridge: a managed Deploy app. Its URL is derived
 *     from the app's target and stable host port - the same addressing the edge
 *     uses to dial apps - and its bearer token plus the inbound ingest key are the
 *     encrypted pair stored on the InstalledApp at install time.
 *
 * Server-only. Cached briefly so the hot paths (send, state poll, ingest) do not
 * hit the database on every call.
 */

import { loadEnv } from "@polaris/config";
import { prisma } from "@polaris/db";
import { decryptSecret } from "@polaris/storage";
import { getPublicIp } from "@/lib/domain-service";
import { hostPortForApp } from "@/lib/deploy-service";

export interface BridgeEndpoint {
    /** Base URL of the bridge API, no trailing slash. */
    baseUrl: string;
    /** Bearer token the bridge API requires. */
    token: string;
    /** Shared key the bridge stamps on inbound events (x-internal-key). */
    ingestKey: string;
}

const CACHE_TTL_MS = 10_000;
let cache: { value: BridgeEndpoint | null; at: number } | null = null;

/** The shared-secret pair stored (encrypted) on the installed bridge row. */
interface BridgeSecrets {
    token: string;
    ingestKey: string;
}

/** Read the static-env bridge config, or null when no bridge URL is set there. */
function fromEnv(): BridgeEndpoint | null {
    const baseUrl = (process.env.MESSAGING_BRIDGE_URL ?? "").replace(/\/+$/, "");
    if (!baseUrl) return null;
    return {
        baseUrl,
        token: process.env.MESSAGING_BRIDGE_TOKEN ?? "",
        ingestKey: process.env.MESSAGING_INGEST_KEY ?? ""
    };
}

/** Derive the endpoint from a marketplace-installed, running bridge, or null. */
async function fromInstall(): Promise<BridgeEndpoint | null> {
    const installed = await prisma.installedApp.findFirst({
        where: { catalogId: "messaging-bridge", status: "running", applicationId: { not: null } },
        orderBy: { createdAt: "desc" }
    });
    if (!installed?.applicationId) return null;
    if (!installed.encryptedSecret || !installed.secretNonce || !installed.secretKeyId) return null;

    const application = await prisma.application.findFirst({
        where: { id: installed.applicationId },
        select: { target: { select: { kind: true, host: { select: { address: true } } } } }
    });
    if (!application) return null;

    // Same host addressing the edge uses to dial apps: a remote target's SSH host
    // address, else the local host's LAN IP. If neither is known the bridge is not
    // reachable from here (the edge would be equally stuck), so report unconfigured.
    const dialHost =
        application.target.kind === "local"
            ? await getPublicIp()
            : application.target.host?.address?.trim() ?? null;
    if (!dialHost) return null;

    let secrets: BridgeSecrets;
    try {
        const plain = decryptSecret(
            {
                ciphertext: Buffer.from(installed.encryptedSecret),
                nonce: Buffer.from(installed.secretNonce),
                keyId: installed.secretKeyId
            },
            loadEnv().POLARIS_MASTER_KEY
        );
        secrets = JSON.parse(plain) as BridgeSecrets;
    } catch {
        return null;
    }
    if (!secrets.token || !secrets.ingestKey) return null;

    return {
        baseUrl: `http://${dialHost}:${hostPortForApp(installed.applicationId)}`,
        token: secrets.token,
        ingestKey: secrets.ingestKey
    };
}

/** Resolve the active bridge endpoint (env override wins), or null if none. */
export async function resolveBridge(): Promise<BridgeEndpoint | null> {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
    const value = fromEnv() ?? (await fromInstall());
    cache = { value, at: Date.now() };
    return value;
}

/** Drop the cached endpoint so the next resolve re-reads (after install/removal). */
export function invalidateBridgeCache(): void {
    cache = null;
}

/** Whether any bridge (env or installed) is currently reachable. */
export async function isBridgeConfigured(): Promise<boolean> {
    return (await resolveBridge()) !== null;
}
