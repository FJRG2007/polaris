/**
 * Opening a Send (/vs/<accessId>#<key>).
 *
 * Public: whoever holds the link has no account here, and the key in the
 * fragment is the credential. The server renders nothing but the frame - it
 * cannot read the Send, and the fragment never reaches it - so everything real
 * happens in the client component below.
 */

import { SendReader } from "./send-reader";
import { Messages } from "@/components/i18n/messages";
import type { Metadata } from "next";
import { linkPreviewMetadata } from "@/lib/link-preview/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Send is end-to-end encrypted: its preview never names anything. */
export async function generateMetadata(): Promise<Metadata> {
    return linkPreviewMetadata("send", "");
}

export default async function PublicSendPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return (
        <Messages namespaces={["publicPages"]}>
            <SendReader accessId={id} />
        </Messages>
    );
}
