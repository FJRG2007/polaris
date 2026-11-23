/**
 * The worker's half of the page check (docs/integrity.md): on a page of a
 * Polaris server somebody added, the page script hashes the files of code the
 * page loaded and the shared checker (`@polaris/core/integrity`) decides what
 * they mean - the build stamp asked of the server, the manifest fetched from
 * GitHub, never from the server.
 */

import { createIntegrityChecker } from "@polaris/core/integrity";

export { MAX_FILES, readFiles } from "@polaris/core/integrity";

const checker = createIntegrityChecker();

/** The verdict for a page of `origin`. */
export const checkPage = (origin: string, files: Parameters<typeof checker.check>[1]) => checker.check(origin, files);

/** The match pattern a page script is registered on for a server's origin.
 *  Without the port, which match patterns do not take; the worker checks the
 *  exact origin of every page that asks. */
export function originPattern(origin: string): string | null {
    try {
        const url = new URL(origin);
        if (url.protocol !== "https:" && url.protocol !== "http:") return null;
        return `${url.protocol}//${url.hostname}/*`;
    } catch {
        return null;
    }
}
