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
import { formatBytes } from "@polaris/core";
import { Badge, Card, CardBody, CardHeader, CardTitle, PolarisMark } from "@polaris/ui";
import { getSession } from "@/lib/session";
import { clientIp } from "@/lib/request-context";
import {
    fileRequestIpAllowed,
    fileRequestUnlockCookie,
    fileRequestUsability,
    parseStringArray,
    resolveFileRequestByToken,
    verifyFileRequestUnlock
} from "@/lib/file-request-service";
import { DropUploader } from "./upload-form";
import { RequestPasswordForm } from "./request-password-form";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function Shell({ children }: { children: React.ReactNode }) {
    return (
        <div className="mx-auto flex min-h-screen max-w-2xl flex-col gap-4 p-6">
            <div className="flex items-center gap-2 text-muted-foreground">
                <PolarisMark className="size-6" />
                <span className="text-sm font-medium">Polaris</span>
            </div>
            {children}
        </div>
    );
}

function Notice({ title, message }: { title: string; message: string }) {
    return (
        <Shell>
            <Card>
                <CardHeader>
                    <CardTitle>{title}</CardTitle>
                </CardHeader>
                <CardBody>
                    <p className="text-sm text-muted-foreground">{message}</p>
                </CardBody>
            </Card>
        </Shell>
    );
}

export default async function DropPointPage({ params }: { params: Promise<{ token: string }> }) {
    const { token } = await params;
    const request = await resolveFileRequestByToken(token);
    if (!request) return <Notice title="Link unavailable" message="This drop point does not exist or was removed." />;

    const usable = fileRequestUsability(request);
    if (!usable.ok) {
        return (
            <Notice
                title="Link unavailable"
                message={usable.reason === "expired" ? "This drop point has expired." : "This drop point was closed."}
            />
        );
    }

    if (!fileRequestIpAllowed(request.allowedCidrs, await clientIp())) {
        return <Notice title="Not available" message="This drop point is not available from your network." />;
    }

    if (request.passwordHash) {
        const cookieValue = (await cookies()).get(fileRequestUnlockCookie(request.id))?.value;
        if (!verifyFileRequestUnlock(request.id, cookieValue, loadEnv().POLARIS_AUTH_SECRET)) {
            return <RequestPasswordForm token={token} title={request.title} />;
        }
    }

    if (request.requireLogin) {
        const session = await getSession();
        if (!session?.user) {
            return (
                <Shell>
                    <Card>
                        <CardHeader>
                            <CardTitle>{request.title}</CardTitle>
                        </CardHeader>
                        <CardBody className="flex flex-col gap-3 text-sm">
                            <p className="text-muted-foreground">This drop point requires you to sign in first.</p>
                            <Link
                                href="/oauth/login"
                                className="inline-flex w-fit items-center rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground hover:bg-primary/90"
                            >
                                Sign in
                            </Link>
                        </CardBody>
                    </Card>
                </Shell>
            );
        }
    }

    const allowedExtensions = parseStringArray(request.allowedExtensions);
    const maxSizeBytes = Number(request.maxSizeBytes);

    return (
        <Shell>
            <Card>
                <CardHeader>
                    <CardTitle>{request.title}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-4">
                    {request.instructions ? (
                        <p className="whitespace-pre-line text-sm text-muted-foreground">{request.instructions}</p>
                    ) : null}
                    <div className="flex flex-wrap gap-2 text-xs">
                        <Badge variant="neutral">
                            {allowedExtensions.length === 0
                                ? "Any file type"
                                : allowedExtensions.map((extension) => `.${extension}`).join(" ")}
                        </Badge>
                        <Badge variant="neutral">Up to {formatBytes(BigInt(maxSizeBytes))} each</Badge>
                        {request.maxFiles !== null ? <Badge variant="neutral">Max {request.maxFiles} files</Badge> : null}
                        {request.expiresAt ? (
                            <Badge variant="neutral">
                                Open until {new Date(request.expiresAt).toLocaleDateString()}
                            </Badge>
                        ) : null}
                    </div>
                    <DropUploader token={token} allowedExtensions={allowedExtensions} maxSizeBytes={maxSizeBytes} />
                </CardBody>
            </Card>
        </Shell>
    );
}
