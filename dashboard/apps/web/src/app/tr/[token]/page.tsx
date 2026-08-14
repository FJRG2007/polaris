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
    const request = await textRequests.resolveTextRequestByToken(token);
    if (!request) {
        return <LinkUnavailable message="This drop point does not exist or was removed." />;
    }

    const usable = textRequests.textRequestUsability(request);
    if (!usable.ok) {
        if (usable.reason === "scheduled" && request.startsAt) {
            const format = await getDisplayFormat();
            return (
                <LinkUnavailable
                    title="Not open yet"
                    message={`This drop point opens on ${format.date(request.startsAt)}.`}
                />
            );
        }
        return (
            <LinkUnavailable
                title="Closed"
                message="This drop point is no longer accepting anything."
            />
        );
    }

    const ip = await clientIp();
    if ((await linkAddressDenial(request, ip)) || !(await dymoIpAllowed(ip)).allowed) {
        return <LinkUnavailable message="This drop point is not available from your network." />;
    }

    const session = await getSession();
    const userId = session?.user?.id ?? null;
    const signedIn = Boolean(session?.user);
    await noteActivity(session?.session?.id);

    if (request.requireLogin && !userId) {
        return (
            <LinkUnavailable
                signedIn={false}
                title="Sign in to continue"
                message="Whoever set this up asked that senders identify themselves."
            />
        );
    }
    if (!(await textRequests.textRequestUserAllowed(request.allowedUsers, userId))) {
        return (
            <LinkUnavailable
                signedIn={signedIn}
                message="This drop point does not accept submissions from your account."
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
                title="Full"
                message="This drop point has taken everything it was going to."
            />
        );
    }

    return (
        <SubmitTextForm
            token={token}
            title={request.title}
            instructions={request.instructions}
            maxLength={request.maxLength}
            allowSealed={request.allowSealed}
            signedIn={signedIn}
        />
    );
}
