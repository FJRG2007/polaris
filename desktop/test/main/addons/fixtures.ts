/** Fixture add-ons, catalogs and a signing key made for the tests only. */

import { zipSync } from "fflate";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { TrustedKey } from "@/main/addons/signature";
import type { AddonCatalog, AddonEntry } from "@polaris/core/device-addons";

const secret = ed25519.utils.randomSecretKey();
export const TEST_KEYS: readonly TrustedKey[] = [{ id: "test-key", publicKey: Buffer.from(ed25519.getPublicKey(secret)).toString("hex") }];

export function sign(bytes: Uint8Array, keyId = "test-key"): string {
    return JSON.stringify({ keyId, signature: Buffer.from(ed25519.sign(bytes, secret)).toString("base64") });
}

export const manifest = {
    schema: 1,
    id: "fixture-mixer",
    name: "Fixture Mixer",
    version: "1.0.0",
    publisher: "Polaris tests",
    summary: "A fixture add-on.",
    category: "devices",
    minAppVersion: "0.1.0",
    entries: { "linux-x64": "main.js", "win32-x64": "main.js" },
    claims: [{ vendorId: 0x06f8, productId: 0xe053, name: "Fixture device" }],
    permissions: ["usb", "polaris-actions"],
    settings: [{ kind: "toggle", key: "lights", label: { "en-US": "Lights" }, default: true }]
} as const;

export function zip(files: Record<string, string>): Uint8Array {
    return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, new TextEncoder().encode(text)])));
}

export function fixturePackage(overrides: Record<string, unknown> = {}, extra: Record<string, string> = {}): Uint8Array {
    return zip({ "manifest.json": JSON.stringify({ ...manifest, ...overrides }), "main.js": "// fixture add-on\n", ...extra });
}

export const PACKAGE_URL = "https://github.com/FJRG2007/polaris/releases/download/device-addons/fixture-mixer-1.0.0.zip";

export function entryFor(bytes: Uint8Array, overrides: Partial<AddonEntry> = {}): AddonEntry {
    const pkg = { url: PACKAGE_URL, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
    return {
        ...(manifest as unknown as AddonEntry),
        entries: { ...manifest.entries },
        claims: [...manifest.claims],
        permissions: [...manifest.permissions],
        settings: manifest.settings as unknown as AddonEntry["settings"],
        packages: { "linux-x64": pkg, "win32-x64": pkg },
        screenshots: [],
        changelog: "",
        published: "2026-11-20T00:00:00.000Z",
        ...overrides
    };
}

export function catalogOf(addons: AddonEntry[], issued = "2026-11-20T00:00:00.000Z"): AddonCatalog {
    return { schema: 1, issued, addons };
}

/** A fetch answering from a table of URLs. */
export function fakeFetch(table: Record<string, Uint8Array | string>, calls: string[] = []) {
    return async (url: string): Promise<Response> => {
        calls.push(url);
        const body = table[url];
        if (body === undefined) return new Response("missing", { status: 404 });
        return new Response(typeof body === "string" ? body : Buffer.from(body), { status: 200 });
    };
}
