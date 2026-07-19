/**
 * Public share landing. Anyone with the link reaches this page; no session is
 * required, because the token (plus an optional password) is the credential.
 * Every gate is enforced server-side on each request: the share must exist, be
 * unexpired/unrevoked/under its download cap, and - when protected - carry a
 * valid unlock cookie. A file share shows a download; a folder share is
 * browseable within its subtree only.
 */

import Link from "next/link";
import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { baseName, formatBytes, normalizeRelPath } from "@polaris/core";
import { Badge, Card, CardBody, CardHeader, CardTitle, PolarisMark } from "@polaris/ui";
import { ChevronRight, Download, Eye, File, Folder, FolderOpen } from "lucide-react";
import { getDriverForConnection } from "@/lib/storage-service";
import {
    logShareAccess,
    resolveShareByToken,
    resolveWithinShare,
    shareIpAllowed,
    shareUnlockCookie,
    shareUsability,
    verifyShareUnlock
} from "@/lib/share-service";
import { clientIp, clientUserAgent, hashForLog } from "@/lib/request-context";
import { SharePasswordForm } from "./share-password-form";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function Shell({ children }: { children: React.ReactNode }) {
    return (
        <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-6">
            <div className="flex items-center gap-2 text-muted-foreground">
                <PolarisMark className="size-6" />
                <span className="text-sm font-medium">Polaris</span>
            </div>
            {children}
        </div>
    );
}

function Unavailable({ message }: { message: string }) {
    return (
        <Shell>
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

    const share = await resolveShareByToken(token);
    if (!share) return <Unavailable message="This link does not exist or has been removed." />;

    const usable = shareUsability(share);
    if (!usable.ok) {
        const message =
            usable.reason === "expired"
                ? "This link has expired."
                : usable.reason === "exhausted"
                  ? "This link has reached its download limit."
                  : "This link has been revoked.";
        return <Unavailable message={message} />;
    }

    const ip = await clientIp();
    if (!shareIpAllowed(share.allowedCidrs, ip)) {
        return <Unavailable message="This link is not available from your network." />;
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

    let body: React.ReactNode;
    const driver = await getDriverForConnection(share.connectionId);
    try {
        const stat = await driver.stat(current);
        if (stat.kind === "file") {
            body = (
                <Card>
                    <CardBody className="flex items-center justify-between gap-4">
                        <div className="flex min-w-0 items-center gap-3">
                            <File className="size-5 shrink-0 text-muted-foreground" />
                            <div className="min-w-0">
                                <p className="truncate font-medium">{baseName(current)}</p>
                                <p className="text-xs text-muted-foreground">{formatBytes(stat.size)}</p>
                            </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                            {share.allowPreview ? (
                                <a
                                    href={`/api/s/${token}/download?p=${encodeURIComponent(current)}&disposition=inline`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-card-hover"
                                >
                                    <Eye className="size-4" />
                                    Preview
                                </a>
                            ) : null}
                            {share.allowDownload ? (
                                <a
                                    href={`/api/s/${token}/download?p=${encodeURIComponent(current)}`}
                                    className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                                >
                                    <Download className="size-4" />
                                    Download
                                </a>
                            ) : null}
                        </div>
                    </CardBody>
                </Card>
            );
        } else {
            const { entries } = await driver.list(current);
            // Breadcrumb segments relative to the share root.
            const rel = current === root ? "" : current.slice(root ? root.length + 1 : 0);
            const segments = rel ? rel.split("/") : [];
            const crumbHref = (target: string) =>
                target ? `/s/${token}?p=${encodeURIComponent(target)}` : `/s/${token}`;
            body = (
                <Card>
                    <CardHeader>
                        <div className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
                            <FolderOpen className="size-4" />
                            <Link href={crumbHref(root)} className="hover:text-foreground">
                                {share.connection.name}
                            </Link>
                            {segments.map((segment, index) => {
                                const target = `${root ? `${root}/` : ""}${segments.slice(0, index + 1).join("/")}`;
                                return (
                                    <span key={target} className="flex items-center gap-1">
                                        <ChevronRight className="size-3" />
                                        <Link href={crumbHref(target)} className="truncate hover:text-foreground">
                                            {segment}
                                        </Link>
                                    </span>
                                );
                            })}
                        </div>
                    </CardHeader>
                    <CardBody className="p-0">
                        {entries.length === 0 ? (
                            <p className="p-6 text-center text-sm text-muted-foreground">This folder is empty.</p>
                        ) : (
                            <ul className="divide-y divide-border">
                                {entries.map((entry) => (
                                    <li key={entry.path}>
                                        {entry.kind === "dir" ? (
                                            <Link
                                                href={crumbHref(entry.path)}
                                                className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-card-hover"
                                            >
                                                <Folder className="size-4 text-primary" />
                                                <span className="flex-1 truncate">{entry.name}</span>
                                            </Link>
                                        ) : (
                                            <div className="flex items-center gap-3 px-4 py-2.5 text-sm">
                                                <File className="size-4 text-muted-foreground" />
                                                <span className="flex-1 truncate">{entry.name}</span>
                                                <span className="text-xs text-muted-foreground">
                                                    {formatBytes(entry.size)}
                                                </span>
                                                {share.allowPreview ? (
                                                    <a
                                                        href={`/api/s/${token}/download?p=${encodeURIComponent(entry.path)}&disposition=inline`}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="text-muted-foreground hover:text-foreground"
                                                        aria-label={`Preview ${entry.name}`}
                                                    >
                                                        <Eye className="size-4" />
                                                    </a>
                                                ) : null}
                                                {share.allowDownload ? (
                                                    <a
                                                        href={`/api/s/${token}/download?p=${encodeURIComponent(entry.path)}`}
                                                        className="text-muted-foreground hover:text-foreground"
                                                        aria-label={`Download ${entry.name}`}
                                                    >
                                                        <Download className="size-4" />
                                                    </a>
                                                ) : null}
                                            </div>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardBody>
                </Card>
            );
        }
    } catch {
        body = <Unavailable message="The shared item could not be read. It may have been moved or deleted." />;
        return body;
    } finally {
        await driver.dispose();
    }

    return (
        <Shell>
            <div className="flex items-center justify-between gap-2">
                <h1 className="text-lg font-semibold">Shared with you</h1>
                {share.maxDownloads !== null ? (
                    <Badge variant="neutral">
                        {Math.max(0, share.maxDownloads - share.downloadCount)} download(s) left
                    </Badge>
                ) : null}
            </div>
            {body}
        </Shell>
    );
}
