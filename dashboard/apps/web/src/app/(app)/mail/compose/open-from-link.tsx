"use client";

/**
 * Open the composer from a `mailto:` link, once.
 *
 * The address is then put back to the inbox, replaced rather than pushed, so a
 * reload or a Back does not open the same message a second time - the link was
 * a request to start writing, not a page to return to.
 */

import * as core from "@polaris/core";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { CONNECT_MAILBOX_HREF, useMail } from "../mail-shell";

export function OpenFromLink({ seed }: { seed: core.MailtoSeed | null }) {
    const { openComposer, accounts } = useMail();
    const router = useRouter();
    const done = useRef(false);
    const hasMailbox = accounts.length > 0;

    useEffect(() => {
        if (done.current) return;
        done.current = true;
        // Nothing to send it from: connecting a mailbox comes first, and the
        // inbox would only be a second hop on the way there.
        if (!hasMailbox) {
            router.replace(CONNECT_MAILBOX_HREF, { scroll: false });
            return;
        }
        if (seed) {
            const people = (addresses: readonly string[]) =>
                addresses.map((address) => ({ name: "", address }));
            openComposer({
                to: people(seed.to),
                cc: people(seed.cc),
                bcc: people(seed.bcc),
                subject: seed.subject,
                // The link's text is plain and the composer holds Markdown.
                body: core.plainTextToMarkdown(seed.body)
            });
        }
        router.replace("/mail", { scroll: false });
    }, [hasMailbox, openComposer, router, seed]);

    return null;
}
