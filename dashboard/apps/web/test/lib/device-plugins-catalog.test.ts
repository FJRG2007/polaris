/**
 * The published plugin catalog as the dashboard reads it: used only when its
 * signature checks out against a trusted key, as the desktop app does.
 */

import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogSigned, openPublishedCatalog } from "@/lib/device-plugins-catalog";

const MANIFEST = join(__dirname, "../../../../../clients/device-plugins/hercules-stream100/manifest.json");

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex");
const keys = [{ id: "test-key", publicKey: raw }];

const catalog = { schema: 1, issued: "2026-11-20T00:00:00.000Z", plugins: [] };
const bytes = new TextEncoder().encode(JSON.stringify(catalog));
const signatureOf = (data: Uint8Array, keyId = "test-key") => JSON.stringify({ keyId, signature: sign(null, data, privateKey).toString("base64") });

describe("published plugin catalog", () => {
    it("opens a catalog signed by a trusted key", () => {
        expect(catalogSigned(bytes, signatureOf(bytes), keys)).toBe(true);
        expect(openPublishedCatalog(bytes, signatureOf(bytes), keys)).toMatchObject({ schema: 1, plugins: [] });
    });

    it("refuses altered bytes, an unknown key and a broken signature file", () => {
        const altered = new TextEncoder().encode(JSON.stringify({ ...catalog, issued: "2026-11-21T00:00:00.000Z" }));
        expect(openPublishedCatalog(altered, signatureOf(bytes), keys)).toBeNull();
        expect(openPublishedCatalog(bytes, signatureOf(bytes, "other"), keys)).toBeNull();
        expect(openPublishedCatalog(bytes, "not json", keys)).toBeNull();
        expect(openPublishedCatalog(bytes, signatureOf(bytes), [{ id: "test-key", publicKey: "zz" }])).toBeNull();
    });

    it("leaves out an entry it cannot read on its own, so a new plugin never hides the others", () => {
        const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, unknown>;
        const release = "https://github.com/FJRG2007/polaris/releases/download/device-plugins/";
        const known = {
            ...manifest,
            packages: { "win32-x64": { url: `${release}known.zip`, sha256: "a".repeat(64), size: 10 } },
            published: "2026-11-20T00:00:00.000Z"
        };
        const newer = { ...known, id: "from-a-newer-catalog", category: "a-category-added-later" };
        const repeated = { ...known, version: "99.0.0" };
        const listed = { schema: 1, issued: "2026-11-20T00:00:00.000Z", plugins: [newer, known, repeated] };
        const data = new TextEncoder().encode(JSON.stringify(listed));
        const opened = openPublishedCatalog(data, signatureOf(data), keys);
        expect(opened?.plugins.map((plugin) => plugin.id)).toEqual([manifest.id]);
        expect(opened?.plugins[0]?.version).toBe(manifest.version);
    });
});

