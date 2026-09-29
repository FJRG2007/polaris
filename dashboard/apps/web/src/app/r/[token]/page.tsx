/**
 * Public drop-point page. Anyone with the link reaches this to upload files into
 * the owner's chosen folder; the token is the credential. Gates are enforced
 * server-side on each upload (see the upload route); this page mirrors the
 * relevant ones for a clear experience - it refuses when the request is
 * unavailable or blocked for this network, and asks for sign-in when required.
 */

import Link from "next/link";
import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { DropPresence } from "./presence";
import { getSession } from "@/lib/session";
import { noteActivity } from "@/lib/session-guard";
import { formatBytes } from "@polaris/core";
import { DropUploader } from "./upload-form";
import { clientIp } from "@/lib/request-context";
import { LinkPasswordForm } from "@/components/link-password-form";
import { LinkUnavailable, PublicShell } from "@/components/public-shell";
import { unlockFileRequestAction } from "@/app/(app)/drive/request-actions";
import { getDisplayFormat } from "@/lib/display-prefs-service";
import { Messages } from "@/components/i18n/messages";
import { getTranslations } from "@/lib/i18n/request";
import { Badge, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import {
    fileRequestIpAllowed,
    fileRequestUnlockCookie,
    fileRequestUsability,
    fileRequestUserAllowed,
    parseStringArray,
    resolveFileRequestByToken,
    verifyFileRequestUnlock
} from "@/lib/file-request-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function DropPointPage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    const format = await getDisplayFormat();
    const t = await getTranslations("publicPages");
    const tc = await getTranslations("components");
    const request = await resolveFileRequestByToken(token);
    if (!request)
        return (
            <LinkUnavailable
                title={tc("publicShell.unavailable")}
                message={t("dropPoint.notFound")}
            />
        );

    const usable = fileRequestUsability(request);
    if (!usable.ok) {
        if (usable.reason === "scheduled") {
            return (
                <LinkUnavailable
                    title={t("dropPoint.notOpenTitle")}
                    message={
                        request.startsAt
                            ? t("dropPoint.opensOn", { date: format.dateTime(request.startsAt) })
                            : t("dropPoint.opensLater")
                    }
                />
            );
        }
        return (
            <LinkUnavailable
                title={tc("publicShell.unavailable")}
                message={
                    usable.reason === "expired"
                        ? t("dropPoint.expired")
                        : t("dropPoint.closed")
                }
            />
        );
    }

    if (!fileRequestIpAllowed(request.allowedCidrs, await clientIp())) {
        return (
            <LinkUnavailable
                title={t("dropPoint.notAvailableTitle")}
                message={t("dropPoint.network")}
            />
        );
    }

    if (request.passwordHash) {
        const cookieValue = (await cookies()).get(fileRequestUnlockCookie(request.id))?.value;
        if (
            !verifyFileRequestUnlock(
                request.id,
                cookieValue,
                request.passwordHash,
                loadEnv().POLARIS_AUTH_SECRET
            )
        ) {
            return (
                <LinkPasswordForm
                    token={token}
                    unlock={unlockFileRequestAction}
                    description={t("dropPoint.pinDescription", { title: request.title })}
                    label={t("dropPoint.pin")}
                />
            );
        }
    }

    // Someone with an account who opens this page is here, and the directory has no
    // other way to learn that: the session guard runs on the dashboard, not on a
    // public page like this one.
    await noteActivity((await getSession())?.session?.id);

    // A per-user allowlist also forces sign-in, even when requireLogin is off.
    const allowedUsers = parseStringArray(request.allowedUsers);
    if (request.requireLogin || allowedUsers.length > 0) {
        const session = await getSession();
        const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
        if (!userId) {
            return (
                <PublicShell>
                    <Card>
                        <CardHeader>
                            <CardTitle>{request.title}</CardTitle>
                        </CardHeader>
                        <CardBody className="flex flex-col gap-3 text-sm">
                            <p className="text-muted-foreground">
                                {t("dropPoint.signInFirst")}
                            </p>
                            <Link
                                href="/oauth/login"
                                className="inline-flex w-fit items-center rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground hover:bg-primary/90"
                            >
                                {t("dropPoint.signIn")}
                            </Link>
                        </CardBody>
                    </Card>
                </PublicShell>
            );
        }
        if (!(await fileRequestUserAllowed(request.allowedUsers, userId))) {
            return (
                <LinkUnavailable
                    title={t("dropPoint.notAvailableTitle")}
                    message={t("dropPoint.restricted")}
                />
            );
        }
    }

    const allowedExtensions = parseStringArray(request.allowedExtensions);
    const deniedExtensions = parseStringArray(request.deniedExtensions);
    const maxSizeBytes = Number(request.maxSizeBytes);
    const minSizeBytes = request.minSizeBytes !== null ? Number(request.minSizeBytes) : 0;

    return (
        <PublicShell>
            <Card>
                <CardHeader>
                    <CardTitle>{request.title}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-4">
                    {request.instructions ? (
                        <p className="whitespace-pre-line text-sm text-muted-foreground">
                            {request.instructions}
                        </p>
                    ) : null}
                    <div className="flex flex-wrap gap-2 text-xs">
                        <Badge variant="neutral">
                            {allowedExtensions.length === 0
                                ? t("dropPoint.anyType")
                                : allowedExtensions.map((extension) => `.${extension}`).join(" ")}
                        </Badge>
                        {deniedExtensions.length > 0 ? (
                            <Badge variant="neutral">
                                {t("dropPoint.denied", {
                                    extensions: deniedExtensions.map((extension) => `.${extension}`).join(" ")
                                })}
                            </Badge>
                        ) : null}
                        <Badge variant="neutral">
                            {t("dropPoint.upTo", { size: formatBytes(BigInt(maxSizeBytes)) })}
                        </Badge>
                        {minSizeBytes > 0 ? (
                            <Badge variant="neutral">
                                {t("dropPoint.atLeast", { size: formatBytes(BigInt(minSizeBytes)) })}
                            </Badge>
                        ) : null}
                        {request.maxFiles !== null ? (
                            <Badge variant="neutral">{t("dropPoint.maxFiles", { count: request.maxFiles })}</Badge>
                        ) : null}
                        {request.expiresAt ? (
                            <Badge variant="neutral">
                                {t("dropPoint.openUntil", { date: format.date(request.expiresAt) })}
                            </Badge>
                        ) : null}
                    </div>
                    <DropPresence token={token} />
                    <Messages namespaces={["publicPages"]}>
                        <DropUploader
                            token={token}
                            allowedExtensions={allowedExtensions}
                            deniedExtensions={deniedExtensions}
                            maxSizeBytes={maxSizeBytes}
                            minSizeBytes={minSizeBytes}
                            allowUploaderDelete={request.allowUploaderDelete}
                            deleteWindowSeconds={request.uploaderDeleteWindowSeconds}
                        />
                    </Messages>
                </CardBody>
            </Card>
        </PublicShell>
    );
}
