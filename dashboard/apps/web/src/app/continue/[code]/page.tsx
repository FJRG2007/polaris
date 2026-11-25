/**
 * Where an old "Continue on phone" link lands. That link is gone: a session
 * opens from Polar on any device signed in to the account, like any chat. A
 * link printed before it went answers the ordinary unavailable page.
 */

import type { Metadata } from "next";
import { getSession } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { LinkUnavailable } from "@/components/public-shell";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function ContinuePage() {
    const t = await getTranslations("publicPages");
    const signedIn = Boolean((await getSession())?.user);
    return <LinkUnavailable signedIn={signedIn} message={t("continueSession.gone")} />;
}
