/**
 * Public text drop point. Somebody was asked for an .env, a key or a log and
 * given this link; the token, plus any password, is the credential.
 *
 * Every gate runs here, server-side, and every one of them runs again inside the
 * submit action: this page decides what to draw, and the action decides what to
 * accept. A page that is the only thing checking is a page somebody can skip.
 */

import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { getSession } from "@/lib/session";
import { clientIp } from "@/lib/request-context";
import { noteActivity } from "@/lib/session-guard";
import { dymoIpAllowed } from "@/lib/dymo-service";
import { SubmitTextForm } from "./submit-text-form";
import { linkAddressDenial } from "@/lib/link-guards";
import * as textRequests from "@/lib/text-request-service";
import { LinkUnavailable } from "@/components/public-shell";
import { getDisplayFormat } from "@/lib/display-prefs-service";
import { Messages } from "@/components/i18n/messages";
import { getTranslations } from "@/lib/i18n/request";
import { LinkPasswordForm } from "@/components/link-password-form";
import { unlockTextRequestAction } from "@/app/(app)/drive/drop-points/text-request-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function TextDropPointPage({
    params
}: {
    params: Promise<{ token: string }>;
}) {
    const { token } = await params;
    const t = await getTranslations("publicPages");
    const request = await textRequests.resolveTextRequestByToken(token);
    if (!request) {
        return <LinkUnavailable message={t("dropPoint.notFound")} />;
    }

    const usable = textRequests.textRequestUsability(request);
    if (!usable.ok) {
        if (usable.reason === "scheduled" && request.startsAt) {
            const format = await getDisplayFormat();
            return (
                <LinkUnavailable
                    title={t("dropPoint.notOpenTitle")}
                    message={t("dropPoint.opensOn", { date: format.date(request.startsAt) })}
                />
            );
        }
        return (
            <LinkUnavailable
                title={t("textDrop.closedTitle")}
                message={t("textDrop.closed")}
            />
        );
    }

    const ip = await clientIp();
    if ((await linkAddressDenial(request, ip)) || !(await dymoIpAllowed(ip)).allowed) {
        return <LinkUnavailable message={t("dropPoint.network")} />;
    }

    const session = await getSession();
    const userId = session?.user?.id ?? null;
    const signedIn = Boolean(session?.user);
    await noteActivity(session?.session?.id);

    if (request.requireLogin && !userId) {
        return (
            <LinkUnavailable
                signedIn={false}
                title={t("textDrop.signInTitle")}
                message={t("textDrop.signIn")}
            />
        );
    }
    if (!(await textRequests.textRequestUserAllowed(request.allowedUsers, userId))) {
        return (
            <LinkUnavailable
                signedIn={signedIn}
                message={t("textDrop.account")}
            />
        );
    }

    if (request.passwordHash) {
        const cookieValue = (await cookies()).get(
            textRequests.textRequestUnlockCookie(request.id)
        )?.value;
        if (
            !textRequests.verifyTextRequestUnlock(
                request.id,
                cookieValue,
                request.passwordHash,
                loadEnv().POLARIS_AUTH_SECRET
            )
        ) {
            return <LinkPasswordForm token={token} unlock={unlockTextRequestAction} />;
        }
    }

    const taken = await textRequests.countTextSubmissions(request.id);
    if (request.maxSubmissions !== null && taken >= request.maxSubmissions) {
        return (
            <LinkUnavailable
                signedIn={signedIn}
                title={t("textDrop.fullTitle")}
                message={t("textDrop.full")}
            />
        );
    }

    return (
        <Messages namespaces={["publicPages"]}>
            <SubmitTextForm
                token={token}
                title={request.title}
                instructions={request.instructions}
                maxLength={request.maxLength}
                allowSealed={request.allowSealed}
                signedIn={signedIn}
            />
        </Messages>
    );
}
