/**
 * The page half of the code check (docs/integrity.md) in the Polaris window,
 * the same one the browser extension runs (`@polaris/core/integrity-guard`):
 * the files of code the page loaded from its own origin - and each one it loads
 * later - are hashed here and judged by the main process against the signed
 * manifest of the build the page was served by. A page found changed is covered
 * with a warning and its password and key fields stop taking keystrokes; a
 * genuine page of an earlier build is offered a reload instead.
 */

import { watchPageCode, type GuardReply } from "@polaris/core/integrity-guard";
import type { PageVerdict } from "@polaris/core/integrity";

/** The desktop app's own windows are English-only, as the rest of its UI. */
const WORDS: Omit<GuardReply, "verdict"> = {
    words: {
        title: "This page's code was changed",
        body: "The code this Polaris server sent does not match what Polaris published for its version. Do not type a password or a key here. Sign out from another device and tell the server's administrator.",
        files: "Files that differ:",
        dismiss: "I understand"
    },
    outdated: {
        body: "This page is from another version of Polaris than the one this server runs now. Reload it once you have saved what you are writing.",
        reload: "Reload",
        later: "Not now"
    }
};

export function checkPageCode(ask: (files: unknown, build: string | null) => Promise<PageVerdict | null>): void {
    // Outside a page (the tests load this module in Node) there is nothing to check.
    if (typeof document === "undefined") return;
    const start = (): void =>
        watchPageCode(async (files, build) => {
            const verdict = await ask(files, build);
            return verdict ? { ...WORDS, verdict } : null;
        });
    if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
}
