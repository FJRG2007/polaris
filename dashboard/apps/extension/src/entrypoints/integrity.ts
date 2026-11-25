/**
 * The page half of the code check (docs/integrity.md), on the pages of the
 * Polaris servers somebody added - registered there by the worker
 * (`syncIntegrity` in background.ts), nowhere else.
 *
 * It hashes the files of code the page loaded from its own origin - and every
 * one it loads later, since a page fetches its chunks as it is used - and the
 * worker compares them with the signed manifest of the build the page was
 * served by. When they differ the page is covered with a warning and its
 * password fields stop taking keystrokes, because a changed page is exactly the
 * one that would read a password as it is typed; a genuine page of an earlier
 * build is offered a reload instead. The page side is shared with the desktop app
 * (`@polaris/core/integrity-guard`).
 *
 * Hashed here rather than in the worker where the page's context allows it: a
 * fetch from the page's origin can be answered from the same cache the page
 * was. A page served over plain http has no WebCrypto, and there the worker
 * fetches and hashes instead.
 */

import { INTEGRITY_CHECK, type IntegrityReply } from "@/lib/integrity-messages";
import { watchPageCode } from "@polaris/core/integrity-guard";

export default defineUnlistedScript({
    main() {
        if (window.top !== window) return;
        watchPageCode(async (files, build) => {
            const reply = (await browser.runtime.sendMessage({ kind: INTEGRITY_CHECK, files, build })) as IntegrityReply | undefined;
            return reply?.ok ? reply : null;
        });
    }
});
