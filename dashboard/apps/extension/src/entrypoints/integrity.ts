/**
 * The page half of the code check (docs/integrity.md), on the pages of the
 * Polaris servers somebody added - registered there by the worker
 * (`syncIntegrity` in background.ts), nowhere else.
 *
 * It hashes the files of code the page loaded from its own origin - and every
 * one it loads later, since a page fetches its chunks as it is used - and the
 * worker compares them with the signed manifest of the server's build. When
 * they differ the page is covered with a warning and its password fields stop
 * taking keystrokes, because a changed page is exactly the one that would read a
 * password as it is typed. The page side is shared with the desktop app
 * (`@polaris/core/integrity-guard`).
 *
 * Hashed here rather than in the worker where the page's context allows it: a
 * fetch from the page's origin can be answered from the same cache the page
 * was. A page served over plain http has no WebCrypto, and there the worker
 * fetches and hashes instead.
 */

import { INTEGRITY_CHECK, type IntegrityReply } from "@/lib/integrity-messages";
import { hashPaths, loadedPaths, onNewFiles, warnChanged } from "@polaris/core/integrity-guard";

/** Files already sent, so a later chunk is sent once. */
const sent = new Set<string>();

export default defineUnlistedScript({
    main() {
        if (window.top !== window) return;
        void check();
        onNewFiles(() => void check());
    }
});

async function check(): Promise<void> {
    const paths = loadedPaths(sent);
    if (paths.length === 0) return;
    for (const path of paths) sent.add(path);
    const files = await hashPaths(paths);
    let reply: IntegrityReply | undefined;
    try {
        reply = (await browser.runtime.sendMessage({ kind: INTEGRITY_CHECK, files })) as IntegrityReply | undefined;
    } catch {
        return;
    }
    if (reply?.ok && reply.verdict.kind === "changed") warnChanged(reply.verdict, reply.words);
}
