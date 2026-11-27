/**
 * Build the device plugin catalog and its packages, and sign the catalog
 * (docs/device-plugins.md). Run by .github/workflows/device-plugins.yml.
 *
 *   node clients/device-plugins/scripts/publish.mjs <source dir> <out dir>
 *
 * Every folder in <source dir> is one plugin: `manifest.json`, `listing.json`
 * (icon, picture, screenshots: file names inside the folder; what changed, as
 * `releases` [{ version, notes }] newest first or the older `changelog` string) and the files:
 * those the same everywhere under `any/`, each platform's own under
 * `<platform>/` (a native module CI built for it), laid over `any/`. Writes into <out dir> one zip per plugin and platform, the
 * pictures, `catalog.json` and `catalog.json.sig`, all to be uploaded to the
 * `device-plugins` release, and again on `device-addons`, the name before the rename. The key is the PKCS#8 PEM in DEVICE_ADDONS_SIGNING_KEY.
 *
 * Zips are deterministic (sorted names, fixed times), so a plugin that did not
 * change keeps its hash and is not downloaded again.
 */

import { join } from "node:path";
import { asciiJson } from "./json.mjs";
import { createRequire } from "node:module";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

const require = createRequire(join(process.cwd(), "clients", "desktop", "package.json"));
const { zipSync } = require("fflate");

const RELEASE = "https://github.com/FJRG2007/polaris/releases/download/device-plugins/";
const KEY_ID = "addons-2026-11";
const PLATFORMS = ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];
const FIXED_TIME = new Date("2020-01-01T00:00:00Z");

const [source, out] = process.argv.slice(2);
if (!source || !out) throw new Error("usage: publish.mjs <source dir> <out dir>");
const pem = process.env.DEVICE_ADDONS_SIGNING_KEY;
if (!pem) throw new Error("DEVICE_ADDONS_SIGNING_KEY is not set");
mkdirSync(out, { recursive: true });

function filesUnder(dir, prefix = "") {
    const found = {};
    for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) Object.assign(found, filesUnder(path, `${prefix}${name}/`));
        else found[`${prefix}${name}`] = [new Uint8Array(readFileSync(path)), { mtime: FIXED_TIME }];
    }
    return found;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The legacy string's ceiling in the catalog schema (`pluginEntrySchema.changelog`): longer and no client reads the catalog. */
const CHANGELOG_MAX = 4000;

/**
 * What changed, from `listing.releases` ([{ version, notes }], newest first) or
 * the old `listing.changelog` string. Releases are written as they are and also
 * as the old string, newest first while it fits, for the desktop apps that read
 * only that one. A string past the ceiling stops the publish instead of
 * shipping a catalog that no client would read.
 */
function whatChanged(id, listing) {
    if (Array.isArray(listing.releases) && listing.releases.length > 0) {
        const releases = listing.releases.map(({ version, notes }) => ({ version, notes }));
        let changelog = "";
        for (const { version, notes } of releases) {
            const next = changelog ? `${changelog} ${version}: ${notes}` : `${version}: ${notes}`;
            if (next.length > CHANGELOG_MAX) break;
            changelog = next;
        }
        return { changelog, releases };
    }
    const changelog = listing.changelog ?? "";
    if (changelog.length > CHANGELOG_MAX) throw new Error(`${id}: listing.json changelog is ${changelog.length} characters, over ${CHANGELOG_MAX}; list it as "releases": [{ "version", "notes" }] instead`);
    return { changelog };
}

const plugins = [];
for (const id of existsSync(source) ? readdirSync(source).sort() : []) {
    const dir = join(source, id);
    // This script's own folder sits beside the plugins; it is not one.
    if (id === "scripts" || !statSync(dir).isDirectory()) continue;
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    if (manifest.id !== id) throw new Error(`${id}: manifest id is ${manifest.id}`);
    const listing = existsSync(join(dir, "listing.json")) ? JSON.parse(readFileSync(join(dir, "listing.json"), "utf8")) : {};
    const packages = {};
    for (const platform of PLATFORMS) {
        if (!manifest.entries[platform]) continue;
        const layers = [join(dir, "any"), join(dir, platform)].filter((path) => existsSync(path));
        if (layers.length === 0) throw new Error(`${id}: no files for ${platform}`);
        const files = { ...Object.assign({}, ...layers.map((path) => filesUnder(path))), "manifest.json": [new TextEncoder().encode(asciiJson(manifest, 4)), { mtime: FIXED_TIME }] };
        if (!files[manifest.entries[platform]]) throw new Error(`${id}: ${platform} entry ${manifest.entries[platform]} is missing`);
        if (manifest.view && !files[manifest.view]) throw new Error(`${id}: ${platform} view ${manifest.view} is missing`);
        const zip = zipSync(files, { level: 9 });
        const name = `${id}-${manifest.version}-${platform}.zip`;
        writeFileSync(join(out, name), zip);
        packages[platform] = { url: RELEASE + name, sha256: sha256(zip), size: zip.byteLength };
    }
    const picture = (file) => {
        const name = `${id}-${manifest.version}-${file}`;
        copyFileSync(join(dir, file), join(out, name));
        return RELEASE + name;
    };
    plugins.push({
        ...manifest,
        packages,
        ...(listing.icon ? { icon: picture(listing.icon) } : {}),
        ...(listing.picture ? { picture: picture(listing.picture) } : {}),
        screenshots: (listing.screenshots ?? []).map(picture),
        ...whatChanged(id, listing),
        published: listing.published ?? new Date().toISOString()
    });
}

// `commit` is what the next run's version guard (version-guard.mjs) compares against.
const commit = /^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? "") ? { commit: process.env.GITHUB_SHA } : {};
const catalog = new TextEncoder().encode(asciiJson({ schema: 1, issued: new Date().toISOString(), ...commit, plugins, addons: plugins }));
const signature = sign(null, catalog, createPrivateKey(pem)).toString("base64");
writeFileSync(join(out, "catalog.json"), catalog);
writeFileSync(join(out, "catalog.json.sig"), JSON.stringify({ keyId: KEY_ID, signature }));
console.log(`catalog: ${plugins.length} plugin(s), ${catalog.byteLength} bytes`);
