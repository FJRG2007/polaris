/**
 * The published device plugin catalog, as the dashboard reads it for a page
 * that has no desktop app behind it (the search in a plain browser).
 *
 * It is the same signed index the desktop app fetches - public, the same for
 * every host - and it is used only when its signature checks out against the
 * keys in `@polaris/core/device-plugins`, exactly as the app does. What a device
 * has installed never reaches the server: that stays with the desktop app.
 *
 * Read stale-while-revalidate: the copy held answers at once and a refresh in
 * the background replaces it, one at a time, so a crowd of browsers costs
 * GitHub one request per `FRESH_MS`.
 */

import { createPublicKey, verify } from "node:crypto";
import { follow, readCapped } from "@/lib/safe-fetch";
import {
    PLUGIN_CATALOG_KEYS,
    PLUGIN_CATALOG_MAX_BYTES,
    PLUGIN_CATALOG_URL,
    LEGACY_PLUGIN_CATALOG_URL,
    readPluginCatalog,
    type PluginCatalog
} from "@polaris/core/device-plugins";
import { z } from "zod";

/** How long a held catalog is used before a refresh is started. */
const FRESH_MS = 15 * 60_000;
/** How long a failed fetch waits before the next is tried. */
const RETRY_MS = 60_000;

const signatureSchema = z.object({
    keyId: z.string().min(1).max(64),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/)
});

/** The DER prefix that turns a raw 32-byte Ed25519 public key into SPKI. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

type Key = { readonly id: string; readonly publicKey: string };

/** Whether `bytes` carry a valid signature by one of `keys`. Never throws. */
export function catalogSigned(bytes: Uint8Array, signatureText: string, keys: readonly Key[] = PLUGIN_CATALOG_KEYS): boolean {
    try {
        const parsed = signatureSchema.safeParse(JSON.parse(signatureText));
        if (!parsed.success) return false;
        const key = keys.find((candidate) => candidate.id === parsed.data.keyId);
        if (!key || !/^[0-9a-f]{64}$/.test(key.publicKey)) return false;
        const publicKey = createPublicKey({
            key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(key.publicKey, "hex")]),
            format: "der",
            type: "spki"
        });
        return verify(null, bytes, publicKey, Buffer.from(parsed.data.signature, "base64"));
    } catch {
        return false;
    }
}

/** The catalog the bytes and signature make, or null when either does not check out. */
export function openPublishedCatalog(bytes: Uint8Array, signatureText: string, keys: readonly Key[] = PLUGIN_CATALOG_KEYS): PluginCatalog | null {
    if (bytes.byteLength > PLUGIN_CATALOG_MAX_BYTES || !catalogSigned(bytes, signatureText, keys)) return null;
    try {
        return readPluginCatalog(JSON.parse(Buffer.from(bytes).toString("utf8")));
    } catch {
        return null;
    }
}

async function download(url: string, max: number): Promise<Uint8Array | null> {
    const response = await follow(new URL(url), "application/json,application/octet-stream,*/*", undefined, 20_000);
    if (!response || !response.ok) return null;
    return readCapped(response, max);
}

type Held = { catalog: PluginCatalog; at: number };

let held: Held | null = null;
let failedAt = 0;
let refreshing: Promise<void> | null = null;

function refresh(): Promise<void> {
    refreshing ??= (async () => {
        try {
            const fetchFrom = (url: string) => Promise.all([download(url, PLUGIN_CATALOG_MAX_BYTES), download(`${url}.sig`, 1_024)]);
            let [bytes, signature] = await fetchFrom(PLUGIN_CATALOG_URL);
            // The address from before the rename, while CI still publishes there.
            if (!bytes || !signature) [bytes, signature] = await fetchFrom(LEGACY_PLUGIN_CATALOG_URL);
            const catalog = bytes && signature ? openPublishedCatalog(bytes, Buffer.from(signature).toString("utf8")) : null;
            // Never traded for one issued earlier, so an old signed copy cannot bring back a withdrawn plugin.
            if (!catalog) failedAt = Date.now();
            else if (!held || Date.parse(catalog.issued) >= Date.parse(held.catalog.issued)) held = { catalog, at: Date.now() };
            else held = { ...held, at: Date.now() };
        } catch {
            failedAt = Date.now();
        } finally {
            refreshing = null;
        }
    })();
    return refreshing;
}

/**
 * The published catalog, or null when none has been read yet. The first call
 * waits for the fetch; later ones answer with the copy held and refresh it in
 * the background once it is older than `FRESH_MS`.
 */
export async function publishedPluginCatalog(): Promise<PluginCatalog | null> {
    const now = Date.now();
    const due = (!held || now - held.at > FRESH_MS) && now - failedAt > RETRY_MS;
    if (held) {
        if (due) void refresh();
        return held.catalog;
    }
    if (due) await refresh();
    // Set by the refresh just awaited, which the narrowing above cannot see.
    return (held as Held | null)?.catalog ?? null;
}

/** Forget what is held. For tests. */
export function resetPublishedPluginCatalog(): void {
    held = null;
    failedAt = 0;
    refreshing = null;
}
