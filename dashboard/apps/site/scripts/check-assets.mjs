/**
 * Fails the build when a page of the export points at a picture that is not
 * there. Pages serves the site under a base path (`/polaris`), so a reference
 * from the domain's root (`/logos/x.svg`) lands outside the site, and one into
 * the site whose file the build never wrote is the same broken image. Both pass
 * `next build`, so this reads every exported page after it.
 */

import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const PICTURE = /\.(?:svg|webp|png|jpe?g|gif|avif|ico)$/i;
// Attributes that load a picture; `srcset` lists several, comma separated.
const ATTRIBUTE = /\s(src|srcset|href|content)\s*=\s*"([^"]*)"/gi;
const INLINE_URL = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;

function decode(value) {
    return value
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#x27;|&#39;/g, "'");
}

/** Every picture a page refers to, as written. */
export function pictureRefs(html) {
    const refs = [];
    for (const [, name, raw] of html.matchAll(ATTRIBUTE)) {
        const value = decode(raw);
        const candidates =
            name.toLowerCase() === "srcset"
                ? value.split(",").map((part) => part.trim().split(/\s+/)[0] ?? "")
                : [value.trim()];
        for (const ref of candidates) if (PICTURE.test(ref.split(/[?#]/)[0] ?? "")) refs.push(ref);
    }
    for (const [, raw] of decode(html).matchAll(INLINE_URL)) {
        const ref = raw.trim();
        if (PICTURE.test(ref.split(/[?#]/)[0] ?? "")) refs.push(ref);
    }
    return refs;
}

/**
 * What is wrong with one reference from `page` (a path relative to the export),
 * or null when it loads. `origin` is where the site is published, so an
 * absolute address to the site itself is checked like a path.
 */
export function refProblem(ref, { page, base, origin, exists }) {
    if (ref.startsWith("data:")) return null;
    let path = ref.split(/[?#]/)[0];
    if (/^https?:\/\//i.test(path) || path.startsWith("//")) {
        const url = new URL(path, "https://invalid.example");
        // Compared as URL origins, so a host is matched however it is cased: CI
        // builds the origin from the repository owner ("FJRG2007"), while every
        // address on a page carries the lower-cased host.
        if (url.origin !== new URL(origin).origin)
            return "is hotlinked from another site; keep the file in the repo";
        path = url.pathname;
    }
    let file;
    if (path.startsWith("/")) {
        if (base && path !== base && !path.startsWith(`${base}/`))
            return `is outside the base path ${base}`;
        file = path.slice(base.length).replace(/^\/+/, "");
    } else {
        file = join(dirname(page), path).split(sep).join("/");
    }
    return exists(decodeURIComponent(file)) ? null : "names a file the build did not write";
}

function pages(dir, root = dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return pages(full, root);
        return entry.name.endsWith(".html") ? [relative(root, full).split(sep).join("/")] : [];
    });
}

/** Every broken picture reference in an export, as one line each. */
export function checkExport(outDir, { base, origin }) {
    const problems = [];
    const exists = (file) => existsSync(join(outDir, file));
    for (const page of pages(outDir)) {
        const html = readFileSync(join(outDir, page), "utf8");
        for (const ref of new Set(pictureRefs(html))) {
            const problem = refProblem(ref, { page, base, origin, exists });
            if (problem) problems.push(`${page}: ${ref} ${problem}`);
        }
    }
    return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
    const base = (process.env.SITE_BASE_PATH ?? "/polaris").replace(/\/+$/, "");
    const origin = (process.env.SITE_ORIGIN ?? "https://fjrg2007.github.io").replace(/\/+$/, "");
    const problems = checkExport(outDir, { base, origin });
    if (problems.length > 0) {
        console.error(`[site] ${problems.length} broken picture references:`);
        for (const line of problems.slice(0, 50)) console.error(`  ${line}`);
        process.exit(1);
    }
    console.log("[site] every picture a page refers to is in the export");
}
