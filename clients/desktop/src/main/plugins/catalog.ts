/**
 * The plugin catalog: a small signed index published on the Polaris
 * repository's `device-plugins` release, the same for every host and fetched
 * from GitHub, never from a host.
 *
 * Read stale-while-revalidate: the copy kept on the device answers at once (and
 * offline), a fetch in the background replaces it when it is newer. A catalog is
 * used only when its signature checks out, and never traded for one issued
 * earlier than the one already held, so an old signed catalog cannot be replayed
 * to bring back a package that was withdrawn.
 */

import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { TRUSTED_KEYS, verifySigned, type TrustedKey } from "./signature";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { LEGACY_PLUGIN_CATALOG_URL, PLUGIN_CATALOG_MAX_BYTES, PLUGIN_CATALOG_URL, readPluginCatalog, type PluginCatalog } from "@polaris/core/device-plugins";

export const CATALOG_URL = PLUGIN_CATALOG_URL;
export const LEGACY_CATALOG_URL = LEGACY_PLUGIN_CATALOG_URL;
const CATALOG_FILE = "catalog.json";
const SIGNATURE_FILE = "catalog.json.sig";

export type Fetcher = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string>; }) => Promise<Response>;

/** The catalog the bytes and signature make, or null when either does not check out. */
export function openCatalog(bytes: Uint8Array, signatureText: string, keys: readonly TrustedKey[] = TRUSTED_KEYS): PluginCatalog | null {
    if (bytes.byteLength > PLUGIN_CATALOG_MAX_BYTES) return null;
    let signature: unknown;
    let body: unknown;
    try {
        signature = JSON.parse(signatureText);
    } catch {
        return null;
    }
    if (!verifySigned(bytes, signature, keys)) return null;
    try {
        body = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
        return null;
    }
    return readPluginCatalog(body);
}

/** The copy on this device, or null when there is none or it no longer checks out. */
export async function cachedCatalog(dir: string, keys: readonly TrustedKey[] = TRUSTED_KEYS): Promise<PluginCatalog | null> {
    try {
        const [bytes, signature] = await Promise.all([readFile(join(dir, CATALOG_FILE)), readFile(join(dir, SIGNATURE_FILE), "utf8")]);
        return openCatalog(bytes, signature, keys);
    } catch {
        return null;
    }
}

async function body(response: Response, max: number): Promise<Uint8Array | null> {
    if (!response.ok) return null;
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > max) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > max ? null : bytes;
}

/** The codes Windows answers a rename over a file another handle has open with. */
const BUSY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
/** The waits between rename attempts: about 1.3 s in all, longer than any read of these files. */
const RENAME_WAITS_MS = [10, 20, 40, 80, 160, 320, 640];

/**
 * Rename, waiting out a file that is open elsewhere. Windows refuses to rename
 * over a file while any handle has it open - a store page or the tray reading
 * `installed.json` the moment an install wrote it - with EPERM, where other
 * systems never fail. The same retry graceful-fs does for npm.
 */
async function renameOver(from: string, to: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            await rename(from, to);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            const wait = RENAME_WAITS_MS[attempt];
            if (wait === undefined || !code || !BUSY_CODES.has(code)) throw error;
            await new Promise((resolve) => setTimeout(resolve, wait));
        }
    }
}

/** Write a file by renaming a sibling over it, so a failed write never leaves half of one. */
export async function writeWhole(path: string, data: Uint8Array | string): Promise<void> {
    const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
        await writeFile(temp, data);
        await renameOver(temp, path);
    } catch (error) {
        await rm(temp, { force: true });
        throw error;
    }
}

/** `etag` is what the server called the list it answered, for the next look's `If-None-Match`. */
export type Refresh =
    | { readonly kind: "updated"; readonly catalog: PluginCatalog; readonly etag: string | null; }
    | { readonly kind: "unchanged"; readonly etag: string | null; }
    | { readonly kind: "failed"; };

/**
 * Fetch the published catalog and keep it when it checks out and is newer than
 * `held`. A failure leaves the copy on the device as it was.
 */
export async function refreshCatalog(
    dir: string,
    fetcher: Fetcher,
    held: PluginCatalog | null,
    url = CATALOG_URL,
    keys: readonly TrustedKey[] = TRUSTED_KEYS,
    etag: string | null = null
): Promise<Refresh> {
    try {
        const signal = AbortSignal.timeout(20_000);
        // Asked conditionally only while the list it names is the one held, so a
        // "not modified" can never stand for a list this device does not have.
        const conditional = held && etag ? { "If-None-Match": etag } : null;
        const catalogResponse = await fetcher(url, conditional ? { signal, headers: conditional } : { signal });
        if (catalogResponse.status === 304 && conditional) return { kind: "unchanged", etag };
        const answered = catalogResponse.headers.get("etag");
        const bytes = await body(catalogResponse, PLUGIN_CATALOG_MAX_BYTES);
        if (!bytes) return { kind: "failed" };
        const signatureBytes = await body(await fetcher(`${url}.sig`, { signal }), 1_024);
        if (!signatureBytes) return { kind: "failed" };
        const signature = Buffer.from(signatureBytes).toString("utf8");
        const catalog = openCatalog(bytes, signature, keys);
        if (!catalog) return { kind: "failed" };
        if (held && Date.parse(catalog.issued) <= Date.parse(held.issued)) return { kind: "unchanged", etag: answered };
        await mkdir(dir, { recursive: true });
        // The signature last: a catalog without its signature is read as none.
        await rm(join(dir, SIGNATURE_FILE), { force: true });
        await writeWhole(join(dir, CATALOG_FILE), bytes);
        await writeWhole(join(dir, SIGNATURE_FILE), signature);
        return { kind: "updated", catalog, etag: answered };
    } catch {
        return { kind: "failed" };
    }
}
