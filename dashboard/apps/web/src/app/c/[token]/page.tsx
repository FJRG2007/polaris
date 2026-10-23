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
import { linkDenialMessage } from "@/lib/link-denial";
import { LinkPasswordForm } from "@/components/link-password-form";
import { countPolarShareView, gatePolarShare } from "@/lib/polar/share-access";
import { unlockPolarShareAction } from "./actions";

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
    // The gate runs before anything is read or counted: a password, an expiry
    // or an address rule must not count an opening it did not serve.
    const gate = await gatePolarShare(token);
    if (!gate.ok) {
        if (gate.reason === "not_found") notFound();
        if (gate.reason === "password_required") {
            return <LinkPasswordForm token={token} unlock={unlockPolarShareAction} />;
        }
        return <LinkUnavailable signedIn={signedIn} message={await linkDenialMessage(gate.reason)} />;
    }
    const thread = await readSharedPolarThread(token);
    if (!thread) notFound();
    if (!(await countPolarShareView(gate.shareId))) {
        return <LinkUnavailable signedIn={signedIn} message={await linkDenialMessage("exhausted")} />;
    }
    return (
        <Messages namespaces={["publicPages", "polar", "chat"]}>
            <SharedChat signedIn={signedIn} thread={thread} token={token} />
        </Messages>
    );
}
