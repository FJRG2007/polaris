/**
 * The server checking its own code (docs/integrity.md): the files of code this
 * container serves from `.next/static` and `public`, hashed on disk and compared
 * with the signed manifest CI published for this build - fetched from GitHub,
 * never read from this server - by the same rules the browser extension and
 * the desktop app judge a page with (`@polaris/core/integrity`).
 *
 * Run once after every start, which is also after every update (an update is a
 * new container), and again when an administrator asks from Management >
 * Security. It catches an image that was not built by Polaris' CI, or files
 * changed inside the container after it started. It cannot vouch for itself
 * against someone who controls this server: such a person can change this
 * check too, which is why the clients check the pages on their own.
 */

import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import {
    CODE_EXTENSIONS,
    createIntegrityChecker,
    judge,
    type CheckedFile,
    type IntegrityChecker,
    type IntegrityVerdict
} from "@polaris/core/integrity";
import { buildStamp } from "@/lib/build-stamp";

export interface SelfCheck {
    readonly verdict: IntegrityVerdict;
    /** Files the manifest lists that this server does not have; served, they would 404. */
    readonly missing: number;
    readonly checkedAt: string;
}

/** The most files read: a build serves a few thousand. */
const MAX_FILES = 20_000;

/** The web app's folder: `/app/apps/web` in the image, the app itself in a source run. */
export function webDir(cwd: string = process.cwd()): string | null {
    for (const dir of [cwd, join(cwd, "apps", "web")]) {
        if (existsSync(join(dir, ".next", "static"))) return dir;
    }
    return null;
}

async function walk(root: string, found: string[]): Promise<void> {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (found.length >= MAX_FILES) return;
        const full = join(root, entry.name);
        if (entry.isDirectory()) await walk(full, found);
        else if (entry.isFile()) found.push(full);
    }
}

/** Every file of code the server serves, under the path it is served at, hashed.
 *  The same walk as dashboard/scripts/integrity-manifest.mjs. */
export async function servedFiles(dir: string): Promise<CheckedFile[]> {
    const files: CheckedFile[] = [];
    for (const [root, prefix] of [
        [join(dir, ".next", "static"), "/_next/static/"],
        [join(dir, "public"), "/"]
    ] as const) {
        const found: string[] = [];
        await walk(root, found);
        for (const full of found) {
            const path = prefix + relative(root, full).split(sep).join("/");
            if (!CODE_EXTENSIONS.some((extension) => path.endsWith(extension))) continue;
            const digest = `sha256-${createHash("sha256").update(await readFile(full)).digest("base64")}`;
            files.push({ path, digest });
        }
    }
    return files;
}

let checker: IntegrityChecker | null = null;
let last: Promise<SelfCheck> | null = null;

/** Check now: this build's manifest against the files on disk. */
export async function checkOwnCode(
    options: { stamp?: string | null; dir?: string | null; checker?: IntegrityChecker } = {}
): Promise<SelfCheck> {
    const stamp = options.stamp === undefined ? buildStamp() : options.stamp;
    const dir = options.dir === undefined ? webDir() : options.dir;
    const checkedAt = new Date().toISOString();
    if (!stamp) return { verdict: judge(null, null, []), missing: 0, checkedAt };
    const source = options.checker ?? (checker ??= createIntegrityChecker());
    const manifest = await source.manifest(stamp).catch(() => null);
    if (!manifest || !dir) return { verdict: judge(stamp, manifest, []), missing: 0, checkedAt };
    const files = await servedFiles(dir);
    const present = new Set(files.map((file) => file.path));
    const missing = Object.keys(manifest.files).filter((path) => !present.has(path)).length;
    return { verdict: judge(stamp, manifest, files), missing, checkedAt };
}

/**
 * The last result, checking first when there is none or `fresh` is asked. A
 * result that could not reach GitHub is not kept, so the next look asks again.
 */
export function ownCodeCheck(fresh = false): Promise<SelfCheck> {
    if (!last || fresh) {
        const run = checkOwnCode();
        last = run;
        void run.then(
            (result) => {
                if (result.verdict.kind === "unverifiable" && result.verdict.reason === "no-manifest" && last === run) last = null;
            },
            () => {
                if (last === run) last = null;
            }
        );
    }
    return last;
}

/** The check after a start, logged when it finds something. */
export async function checkOwnCodeAtStart(): Promise<void> {
    const result = await ownCodeCheck(true);
    if (result.verdict.kind === "changed") {
        console.error(
            `polaris: ${result.verdict.paths.length} file(s) of code differ from the signed manifest of build ${result.verdict.build}:`,
            result.verdict.paths.slice(0, 10).join(", ")
        );
    }
}
