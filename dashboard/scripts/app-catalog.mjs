#!/usr/bin/env node
/**
 * Write and sign the published app catalogue (docs/addons-delivery.md).
 *
 *   node scripts/app-catalog.mjs <bundles-index.json> <out-dir> [<app-dir>...]
 *
 * Lists every app under dashboard/apps/ whose package.json has a
 * `polaris.catalog` section, with the bundle the image build just published
 * for it (the Dockerfile's `app-bundles` stage writes <bundles-index.json>).
 * An installed Polaris reads the result at runtime, so an app published after
 * its image was built reaches it without a dashboard update.
 *
 * Signed with the device plugin catalog's key (DEVICE_ADDONS_SIGNING_KEY, a
 * PKCS#8 PEM, key id `addons-2026-11`): the dashboard already trusts its public
 * half (`PLUGIN_CATALOG_KEYS`), and the two catalogues cannot be read as each
 * other - this one says `"kind": "apps"` and has no `plugins` list.
 */

import { join, resolve, dirname } from "node:path";
import { createPrivateKey, sign } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const KEY_ID = "addons-2026-11";
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const HOST_API = /^\d{1,4}\.\d{1,4}$/;

/**
 * Every app package under dashboard/apps/, as the bundler finds them. Not
 * imported from the bundler, which needs esbuild: this runs with Node alone.
 */
function appPackages(dashboard) {
    const apps = join(dashboard, "apps");
    return readdirSync(apps)
        .map((name) => join(apps, name))
        .filter((dir) => {
            try {
                return Boolean(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).polaris);
            } catch {
                return false;
            }
        })
        .sort();
}

/** The default host API an app is written against, as the bundler reads it. */
function defaultHostApi(dashboard) {
    return JSON.parse(readFileSync(join(dashboard, "packages", "app-host", "package.json"), "utf8")).hostApi;
}

/**
 * The catalogue entry for one app package, or null for one that does not opt in.
 * Throws, naming the package, for metadata the dashboard would refuse: a bad
 * entry must stop the publish, never reach installs as a silently dropped app.
 */
export function catalogEntry(pkg, bundle, hostApi, published) {
    const app = pkg.polaris ?? {};
    const about = app.catalog;
    if (!about) return null;
    const fail = (why) => {
        throw new Error(`${pkg.name}: polaris.catalog ${why}`);
    };
    if (!bundle) fail(`names app "${app.id}", which the bundle index does not carry`);
    if (!VERSION.test(pkg.version ?? "")) fail(`needs a MAJOR.MINOR.PATCH version, not "${pkg.version}"`);
    const api = app.hostApi ?? hostApi;
    if (!HOST_API.test(api ?? "")) fail(`host API "${api}" is not MAJOR.MINOR`);
    if (!VERSION.test(about.minPolaris ?? "")) fail("needs minPolaris, the first Polaris release that runs it");
    for (const field of ["name", "summary", "description"]) {
        if (typeof about[field]?.["en-US"] !== "string") fail(`needs ${field}["en-US"]`);
    }
    return {
        id: app.id,
        version: pkg.version,
        hostApi: api,
        minPolaris: about.minPolaris,
        name: about.name,
        summary: about.summary,
        description: about.description,
        category: about.category ?? "Tools",
        keywords: about.keywords ?? [],
        ...(about.logo ? { logo: about.logo } : {}),
        ...(about.nav ? { nav: about.nav } : {}),
        permissions: about.permissions ?? [],
        permissionDefs: about.permissionDefs ?? [],
        bundle: { file: bundle.file, digest: bundle.digest, size: bundle.size },
        coreTables: Boolean(about.coreTables),
        published
    };
}

/** The catalogue's bytes for the packages and bundle index given. */
export function buildCatalog(packages, index, hostApi, issued) {
    const apps = packages
        .map((pkg) => catalogEntry(pkg, index.apps?.[pkg.polaris?.id], hostApi, issued))
        .filter(Boolean)
        .sort((left, right) => left.id.localeCompare(right.id));
    return Buffer.from(`${JSON.stringify({ schema: 1, kind: "apps", issued, apps }, null, 2)}\n`);
}

/** The `.sig` file beside the catalogue: the same shape the plugin catalog's is. */
export function signatureFile(bytes, pem, keyId = KEY_ID) {
    return JSON.stringify({ keyId, signature: sign(null, bytes, createPrivateKey(pem)).toString("base64") });
}

async function main() {
    const [indexPath, out, ...dirs] = process.argv.slice(2);
    if (!indexPath || !out) throw new Error("usage: app-catalog.mjs <bundles-index.json> <out-dir> [<app-dir>...]");
    const pem = process.env.DEVICE_ADDONS_SIGNING_KEY;
    if (!pem) throw new Error("DEVICE_ADDONS_SIGNING_KEY is not set");
    const dashboard = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    const packages = (dirs.length > 0 ? dirs.map((dir) => resolve(dir)) : appPackages(dashboard)).map((dir) =>
        JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
    );
    const bytes = buildCatalog(packages, index, defaultHostApi(dashboard), new Date().toISOString());
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "catalog.json"), bytes);
    writeFileSync(join(out, "catalog.json.sig"), signatureFile(bytes, pem));
    const listed = JSON.parse(bytes.toString("utf8")).apps.map((app) => app.id);
    process.stdout.write(`[app-catalog] ${listed.length} app(s): ${listed.join(", ") || "none"}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    main().catch((error) => {
        process.stderr.write(`${error.stack ?? error}\n`);
        process.exit(1);
    });
}
