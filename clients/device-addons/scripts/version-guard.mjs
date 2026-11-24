/**
 * Refuse to publish an add-on whose package changed under a version already
 * published (docs/device-addons.md, Publishing an add-on). A desktop app that
 * holds that version never takes the new files: it compares versions, not
 * bytes. Run by .github/workflows/device-addons.yml before anything is built.
 *
 *   node scripts/device-addons/version-guard.mjs <source dir> <published catalog.json> [<fallback base commit>]
 *
 * The base is the commit the published catalog was built from (`commit`, which
 * publish.mjs writes), or the fallback for a catalog older than that field.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

/** Sources outside an add-on's folder that end up in its package (the native modules CI builds). */
export const NATIVE_SOURCES = {
    "hercules-stream100": ["crates/polaris-stream100/", "crates/polaris-stream100-node/"]
};

/** Whether a changed repository path is part of the add-on's package. `listing.json` and its pictures are not. */
export function packagedPath(id, path) {
    const own = `clients/device-addons/${id}/`;
    if (path.startsWith(own)) {
        const rest = path.slice(own.length);
        return rest === "manifest.json" || (rest.includes("/") && !rest.startsWith("."));
    }
    return (NATIVE_SOURCES[id] ?? []).some((prefix) => path.startsWith(prefix) && !path.slice(prefix.length).startsWith("tests/"));
}

/**
 * The add-ons that would publish changed files under a version already out:
 * same version as the published catalog's, and a packaged path changed since.
 */
export function staleVersions(addons, published, changed) {
    const out = [];
    for (const { id, version } of addons) {
        const before = published.find((entry) => entry.id === id);
        if (!before || before.version !== version) continue;
        const touched = changed.filter((path) => packagedPath(id, path));
        if (touched.length > 0) out.push({ id, version, touched });
    }
    return out;
}

function main() {
    const [source, catalogPath, fallback] = process.argv.slice(2);
    if (!source || !catalogPath) throw new Error("usage: version-guard.mjs <source dir> <published catalog.json> [<fallback base commit>]");
    if (!existsSync(catalogPath)) return console.log("version guard: nothing published yet");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    const base = typeof catalog.commit === "string" && /^[0-9a-f]{40}$/.test(catalog.commit) ? catalog.commit : fallback;
    if (!base || /^0+$/.test(base)) return console.log("version guard: no base commit to compare with");
    // A shallow checkout has only HEAD: fetch the base too (its tree is all a diff needs).
    try {
        execFileSync("git", ["cat-file", "-e", `${base}^{commit}`], { stdio: "ignore" });
    } catch {
        execFileSync("git", ["fetch", "--quiet", "--no-tags", "--depth=1", "origin", base], { stdio: "inherit" });
    }
    const changed = execFileSync("git", ["diff", "--name-only", base, "HEAD"], { windowsHide: true, encoding: "utf8" }).split("\n").filter(Boolean);
    const addons = readdirSync(source)
        .filter((id) => statSync(join(source, id)).isDirectory() && existsSync(join(source, id, "manifest.json")))
        .map((id) => JSON.parse(readFileSync(join(source, id, "manifest.json"), "utf8")));
    const stale = staleVersions(addons, catalog.addons ?? [], changed);
    for (const item of stale) console.error(`${item.id} ${item.version} is already published, and its package changed since ${base.slice(0, 10)} (${item.touched.slice(0, 5).join(", ")}). Raise its version.`);
    if (stale.length > 0) process.exit(1);
    console.log(`version guard: ${addons.length} add-on(s) checked against ${base.slice(0, 10)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
