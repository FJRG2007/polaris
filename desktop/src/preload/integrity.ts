/**
 * The page half of the code check (docs/integrity.md) in the Polaris window,
 * the same one the browser extension runs (`@polaris/core/integrity-guard`):
 * the files of code the page loaded from its own origin - and each one it loads
 * later - are hashed here and judged by the main process against the signed
 * manifest of the server's build. A page found changed is covered with a
 * warning and its password and key fields stop taking keystrokes.
 */

import { hashPaths, loadedPaths, onNewFiles, warnChanged } from "@polaris/core/integrity-guard";
import type { IntegrityVerdict } from "@polaris/core/integrity";

/** The desktop app's own windows are English-only, as the rest of its UI. */
const WORDS = {
    title: "This page's code was changed",
    body: "The code this Polaris server sent does not match what Polaris published for its version. Do not type a password or a key here. Sign out from another device and tell the server's administrator.",
    files: "Files that differ:",
    dismiss: "I understand"
};

export function checkPageCode(ask: (files: unknown) => Promise<IntegrityVerdict | null>): void {
    // Outside a page (the tests load this module in Node) there is nothing to check.
    if (typeof document === "undefined") return;
    const sent = new Set<string>();
    const check = async (): Promise<void> => {
        const paths = loadedPaths(sent);
        if (paths.length === 0) return;
        for (const path of paths) sent.add(path);
        const verdict = await ask(await hashPaths(paths)).catch(() => null);
        if (verdict?.kind === "changed") warnChanged(verdict, WORDS);
    };
    const start = (): void => {
        void check();
        onNewFiles(() => void check());
    };
    if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
}
