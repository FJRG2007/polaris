/**
 * A Polar chat somebody shared. Anyone with the link reaches this, signed in or
 * not: the token is the credential. It shows the words of the conversation up
 * to when the link was made or last updated, read-only. A token that is not a
 * live link - never made, or revoked - is a 404, the same either way.
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSession } from "@/lib/session";
import { SharedChat } from "./shared-chat";
import { clientIp } from "@/lib/request-context";
import { rateLimit } from "@/lib/rate-limit-service";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";
import { readSharedPolarThread } from "@/lib/polar/share";
import { LinkUnavailable } from "@/components/public-shell";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function SharedPolarChatPage({
    params
}: {
    params: Promise<{ token: string }>;
}) {
    const { token } = await params;
    const signedIn = Boolean((await getSession())?.user);
    const limited = await rateLimit(`polar-shared:${(await clientIp()) ?? "unknown"}`, 120, 60_000);
    if (!limited.ok) {
        const t = await getTranslations("publicPages");
        return <LinkUnavailable signedIn={signedIn} message={t("polarShare.busy")} />;
    }
    const thread = await readSharedPolarThread(token);
    if (!thread) notFound();
    return (
        <Messages namespaces={["publicPages", "polar", "chat"]}>
            <SharedChat signedIn={signedIn} thread={thread} token={token} />
        </Messages>
    );
}
