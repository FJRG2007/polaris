/**
 * A conversation, on paper (/mail/print/<id>).
 *
 * In a route group of its own so none of the app is drawn around it: no rail,
 * no header, no composer - a printout of a mail client's chrome is not what
 * anybody pressed Print for. It reads the conversation through the same
 * owner-narrowed readers the reading pane uses, and a conversation that is not
 * the reader's is the same not-found as one that does not exist.
 */

import type { Metadata } from "next";
import { PrintView } from "./print-view";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { printableThread } from "@/lib/mailbox/printable";
import { DisplayFormatProvider } from "@/components/display-format";
import { resolveDisplayPreferencesFor } from "@/lib/display-prefs-service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Print - Polaris Mail" };

export default async function MailPrintPage({ params }: { params: Promise<{ threadId: string }> }) {
    const user = await requirePermission("mail.use");
    const { threadId } = await params;
    // A malformed id is a link somebody edited, and the answer is the same as
    // for one that names nothing.
    if (!/^[0-9a-f-]{36}$/i.test(threadId)) notFound();
    const [thread, display] = await Promise.all([
        printableThread(user.id, threadId),
        resolveDisplayPreferencesFor(user.id)
    ]);
    if (!thread) notFound();
    // The reader's own date format, which the app chrome would otherwise have
    // provided - this page draws none of it.
    return (
        <DisplayFormatProvider preferences={display}>
            <PrintView thread={thread} />
        </DisplayFormatProvider>
    );
}
