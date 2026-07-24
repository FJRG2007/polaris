/**
 * Public share landing. Anyone with the link reaches this page; no session is
 * required, because the token (plus an optional password) is the credential.
 * Every gate is enforced server-side on each request: the share must exist, be
 * unexpired/unrevoked/under its download cap, clear the IP/geo/fraud rules, and -
 * when protected - carry a valid unlock cookie. A file share shows the one file
 * with preview/download; a folder share mounts the full read-only Drive explorer
 * (browse, search, sort, list/grid, preview, per-item and ZIP download), scoped
 * to the shared subtree and gated by the token on every request. When the visitor
 * happens to be signed in, the chrome adapts with a shortcut back into the app.
 */

import Link from "next/link";
import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { baseName, normalizeRelPath } from "@polaris/core";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, PolarisMark } from "@polaris/ui";
import { ArrowUpRight, LogIn } from "lucide-react";
import { getDriverForConnection } from "@/lib/storage-service";
import {
    logShareAccess,
    resolveShareByToken,
    resolveWithinShare,
    shareGeoAllowed,
    shareIpAllowed,
    shareUnlockCookie,
    shareUsability,
    verifyShareUnlock
} from "@/lib/share-service";
import { clientIp, clientUserAgent, hashForLog } from "@/lib/request-context";
import { dymoIpAllowed } from "@/lib/dymo-service";
import { getSession } from "@/lib/session";
import { SharePasswordForm } from "./share-password-form";
import { ShareExplorer } from "./share-explorer";
import { ShareFileCard } from "./share-file-card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function Shell({ children, signedIn }: { children: React.ReactNode; signedIn: boolean }) {
    return (
        <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 p-6">
            <header className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-muted-foreground">
                    <PolarisMark className="size-6" />
                    <span className="text-sm font-medium">Polaris</span>
                </div>
                {signedIn ? (
                    <Button asChild size="sm" variant="ghost">
                        <Link href="/drive">
                            Open Polaris
                            <ArrowUpRight className="size-4" />
                        </Link>
                    </Button>
                ) : (
                    <Button asChild size="sm" variant="ghost">
                        <Link href="/oauth/login">
                            <LogIn className="size-4" />
                            Sign in
                        </Link>
                    </Button>
                )}
            </header>
            {children}
        </div>
    );
}

function Unavailable({ message, signedIn }: { message: string; signedIn: boolean }) {
    return (
        <Shell signedIn={signedIn}>
            <Card>
                <CardHeader>
                    <CardTitle>Link unavailable</CardTitle>
                </CardHeader>
                <CardBody>
                    <p className="text-sm text-muted-foreground">{message}</p>
                </CardBody>
            </Card>
        </Shell>
    );
}

export default async function SharePage({
    params,
    searchParams
}: {
    params: Promise<{ token: string }>;
    searchParams: Promise<{ p?: string }>;
}) {
    const { token } = await params;
    const { p } = await searchParams;

    // The visitor may or may not be a Polaris user; the session only tunes the
    // chrome (a shortcut back into the app), never the access decision.
    const session = await getSession();
    const signedIn = Boolean(session?.user);

    const share = await resolveShareByToken(token);
    if (!share) return <Unavailable signedIn={signedIn} message="This link does not exist or has been removed." />;

    const usable = shareUsability(share);
    if (!usable.ok) {
        const message =
            usable.reason === "expired"
                ? "This link has expired."
                : usable.reason === "exhausted"
                  ? "This link has reached its download limit."
                  : "This link has been revoked.";
        return <Unavailable signedIn={signedIn} message={message} />;
    }

    // Same gate order as the token routes so the landing never shows a listing the
    // download endpoints would refuse: IP allowlist, geo, then the fraud check.
    const ip = await clientIp();
    if (!shareIpAllowed(share.allowedCidrs, ip)) {
        return <Unavailable signedIn={signedIn} message="This link is not available from your network." />;
    }
    if (!(await shareGeoAllowed(share.allowedCountries, share.allowedContinents, ip))) {
        return <Unavailable signedIn={signedIn} message="This link is not available from your location." />;
    }
    if (!(await dymoIpAllowed(ip)).allowed) {
        return <Unavailable signedIn={signedIn} message="This link is not available from your network." />;
    }

    if (share.passwordHash) {
        const cookieValue = (await cookies()).get(shareUnlockCookie(share.id))?.value;
        if (!verifyShareUnlock(share.id, cookieValue, loadEnv().POLARIS_AUTH_SECRET)) {
            return <SharePasswordForm token={token} />;
        }
    }

    // Record a view (the visitor passed every gate). Best-effort; never blocks.
    void logShareAccess({
        shareId: share.id,
        action: "view",
        ip,
        ipHash: hashForLog(ip),
        userAgentHash: hashForLog(await clientUserAgent())
    });

    const root = normalizeRelPath(share.path);
    const current = resolveWithinShare(share.path, p ?? null) ?? root;

    // Resolve whether the current target is a file or a folder up front; the driver
    // is only needed for this one stat - the explorer streams its own listings.
    let isFile: boolean;
    let fileSize = "0";
    const driver = await getDriverForConnection(share.connectionId);
    try {
        const stat = await driver.stat(current);
        isFile = stat.kind === "file";
        if (isFile) fileSize = stat.size.toString();
    } catch {
        return (
            <Unavailable
                signedIn={signedIn}
                message="The shared item could not be read. It may have been moved or deleted."
            />
        );
    } finally {
        await driver.dispose();
    }

    return (
        <Shell signedIn={signedIn}>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h1 className="text-lg font-semibold">Shared with you</h1>
                {share.maxDownloads !== null ? (
                    <Badge variant="neutral">
                        {Math.max(0, share.maxDownloads - share.downloadCount)} download(s) left
                    </Badge>
                ) : null}
            </div>
            {isFile ? (
                <ShareFileCard
                    token={token}
                    name={baseName(current)}
                    path={current}
                    size={fileSize}
                    allowDownload={share.allowDownload}
                    allowPreview={share.allowPreview}
                />
            ) : (
                <ShareExplorer
                    token={token}
                    rootName={share.connection.name}
                    rootPath={root}
                    initialPath={current}
                    allowDownload={share.allowDownload}
                    allowPreview={share.allowPreview}
                    allowUpload={share.allowUpload}
                    allowRename={share.allowRename}
                    allowDelete={share.allowDelete}
                    allowCreateFolder={share.allowCreateFolder}
                />
            )}
        </Shell>
    );
}
