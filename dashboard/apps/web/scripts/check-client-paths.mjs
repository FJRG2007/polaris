/**
 * Fail the build when a file served to browsers carries a path from the machine
 * that built it. Runs as the web app's postbuild, so a dependency that starts
 * baking one in (a bare `import.meta.url`, `__filename`, a source path in an
 * error string) stops the build instead of publishing the builder's account name
 * and disk layout to every visitor.
 *
 * Looks under `.next/static` - everything the browser downloads - for the
 * workspace root and the home directory, in every spelling a bundler writes them:
 * native, forward-slashed, as a `file://` URL and JSON-escaped.
 */

import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

const TEXT = /\.(?:m?js|css|json|map|html|txt|svg)$/i;

/** Every way `path` can appear inside a built file. Paths too short to be specific are skipped. */
export function spellings(path) {
    const native = resolve(path);
    if (native.replace(/[\\/]+$/, "").length < 4) return [];
    const forward = native.replaceAll("\\", "/");
    const forms = new Set([native, forward, JSON.stringify(native).slice(1, -1), pathToFileURL(native).href]);
    // A drive letter is written in either case, depending on who formatted it.
    for (const form of [...forms]) {
        const drive = /^([A-Za-z]):/.exec(form) ?? /^file:\/\/\/([A-Za-z]):/.exec(form);
        if (drive) {
            forms.add(form.replace(`${drive[1]}:`, `${drive[1].toLowerCase()}:`));
            forms.add(form.replace(`${drive[1]}:`, `${drive[1].toUpperCase()}:`));
        }
    }
    return [...forms];
}

/** The lines of `text` that contain any of `needles`, trimmed to a readable excerpt. */
export function findLeaks(text, needles) {
    const hits = [];
    for (const needle of needles) {
        if (hits.length) break;
        let at = text.indexOf(needle);
        while (at !== -1 && hits.length < 5) {
            hits.push(text.slice(Math.max(0, at - 40), at + needle.length + 40).replace(/\s+/g, " "));
            at = text.indexOf(needle, at + needle.length);
        }
    }
    return hits;
}

function* files(dir) {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) yield* files(path);
        else if (TEXT.test(entry)) yield path;
    }
}

function main() {
    const app = join(dirname(fileURLToPath(import.meta.url)), "..");
    const workspace = join(app, "..", "..");
    const staticDir = join(app, ".next", "static");
    // Longest first, so the workspace is matched and masked before the home
    // directory it usually sits in.
    const needles = [...new Set([...spellings(workspace), ...spellings(homedir())])].sort((a, b) => b.length - a.length);
    let leaks = 0;
    for (const file of files(staticDir)) {
        const hits = findLeaks(readFileSync(file, "utf8"), needles);
        if (!hits.length) continue;
        leaks += 1;
        // The excerpt names the leaked path; print it with the path itself masked.
        const masked = [...new Set(hits.map((hit) => needles.reduce((line, needle) => line.replaceAll(needle, "<build path>"), hit)))];
        process.stderr.write(`${relative(app, file)}:\n${masked.map((hit) => `    ...${hit}...`).join("\n")}\n`);
    }
    if (leaks) {
        process.stderr.write(`check-client-paths: ${leaks} file(s) under .next/static contain a path from this machine.\n`);
        return 1;
    }
    process.stdout.write("check-client-paths: no build-machine paths in .next/static\n");
    return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main();
