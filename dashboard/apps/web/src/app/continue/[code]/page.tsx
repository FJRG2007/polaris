/**
 * A "Continue on phone" link (`lib/agents/session-pairing.ts`). Signed in as
 * the person who made it: spent and sent to the session. Signed out: a QR
 * sign-in the person approves with their PIN on the computer. Anything else
 * - spent, expired, or another account's - is one answer.
 */

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { clientIp } from "@/lib/request-context";
import { ContinueSignIn } from "./continue-sign-in";
import { rateLimit } from "@/lib/rate-limit-service";
import { getTranslations } from "@/lib/i18n/request";
import { LinkUnavailable } from "@/components/public-shell";
import { polarSessionHref } from "@/lib/agents/agent-notices";
import { PAIRING_CODE, readPairing, spendPairing } from "@/lib/agents/session-pairing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function ContinuePage({ params }: { params: Promise<{ code: string }> }) {
    const { code } = await params;
    const t = await getTranslations("publicPages");
    const user = (await getSession())?.user ?? null;
    const limited = await rateLimit(`session-continue-page:${(await clientIp()) ?? "unknown"}`, 60, 60_000);
    if (!limited.ok) return <LinkUnavailable signedIn={Boolean(user)} message={t("continueSession.busy")} />;
    if (!PAIRING_CODE.test(code)) return <LinkUnavailable signedIn={Boolean(user)} message={t("continueSession.gone")} />;
    if (user) {
        const sessionId = await spendPairing(code, user.id);
        if (sessionId) redirect(polarSessionHref(sessionId));
        return <LinkUnavailable signedIn message={t("continueSession.gone")} />;
    }
    if (!(await readPairing(code))) return <LinkUnavailable signedIn={false} message={t("continueSession.gone")} />;
    return (
        <ContinueSignIn
            code={code}
            words={{
                title: t("continueSession.title"),
                waiting: t("continueSession.waiting"),
                approved: t("continueSession.approved"),
                denied: t("continueSession.denied"),
                gone: t("continueSession.gone"),
                busy: t("continueSession.busy")
            }}
        />
    );
}
