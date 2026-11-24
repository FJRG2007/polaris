/**
 * The main process's half of the page code check (docs/integrity.md), the same
 * one the browser extension runs: the preload hashes the files of code a Polaris
 * page loaded and this compares them with the signed manifest of the server's
 * build - asked of the server by its build stamp, fetched from GitHub, never
 * from the server (`@polaris/core/integrity`).
 *
 * Requests go through the window's own session, so a server whose certificate
 * this app pins (local-ca-pin.ts) answers here as it does to the page.
 *
 * A page found changed is remembered for as long as its window lives, and the
 * chat key's device lock (key-wrap.ts) refuses it: a changed page is exactly the
 * one that would take the key once unwrapped.
 */

import type { Session, WebContents } from "electron";
import {
    createIntegrityChecker,
    readFiles,
    servedPath,
    sriDigest,
    type IntegrityChecker,
    type IntegrityVerdict
} from "@polaris/core/integrity";

const checkers = new WeakMap<Session, IntegrityChecker>();
const changed = new WeakSet<WebContents>();

function checkerFor(session: Session): IntegrityChecker {
    let checker = checkers.get(session);
    if (!checker) {
        checker = createIntegrityChecker((url, init) => session.fetch(url, init));
        checkers.set(session, checker);
    }
    return checker;
}

/**
 * The verdict for the files a page of `origin` says it loaded, or null when what
 * it sent is not a list of files. A file the page could not hash (plain http has
 * no WebCrypto) is fetched and hashed here; one that cannot be is left out.
 */
export async function checkPageFiles(contents: WebContents, origin: string, raw: unknown): Promise<IntegrityVerdict | null> {
    const files = readFiles(raw);
    if (!files) return null;
    const session = contents.session;
    const hashed = await Promise.all(
        files.map(async (file) => {
            if (file.digest) return file;
            try {
                const response = await session.fetch(`${origin}${servedPath(file.path)}`, {
                    credentials: "omit",
                    cache: "force-cache"
                });
                return { path: file.path, digest: response.ok ? await sriDigest(await response.arrayBuffer()) : "" };
            } catch {
                return file;
            }
        })
    );
    const verdict = await checkerFor(session).check(
        origin,
        hashed.filter((file) => file.digest !== "")
    );
    if (verdict.kind === "changed") changed.add(contents);
    return verdict;
}

/** Whether a page in these contents was found changed since its window opened. */
export function pageChanged(contents: WebContents): boolean {
    return changed.has(contents);
}
