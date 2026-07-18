"use client";

/**
 * Manage-shares view. Lists the current user's share links with their guardrails
 * and lets them revoke one. The link itself is not shown here: only the token
 * hash is stored, so the URL exists solely at creation time - revoking is the
 * control we can offer after the fact.
 */

import { useState, useTransition } from "react";
import { Ban, FileText, FolderClosed } from "lucide-react";
import { Badge, Button, Card, CardBody } from "@polaris/ui";
import { revokeShareAction } from "../drive/share-actions";

export interface ShareRow {
    id: string;
    path: string;
    kind: string;
    connectionName: string;
    allowUpload: boolean;
    maxDownloads: number | null;
    downloadCount: number;
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
}

function status(share: ShareRow): { label: string; variant: "success" | "neutral" | "danger" | "warning" } {
    if (share.revokedAt) return { label: "Revoked", variant: "neutral" };
    if (share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now()) {
        return { label: "Expired", variant: "warning" };
    }
    if (share.maxDownloads !== null && share.downloadCount >= share.maxDownloads) {
        return { label: "Exhausted", variant: "warning" };
    }
    return { label: "Active", variant: "success" };
}

export function SharedView({ shares }: { shares: ShareRow[] }) {
    const [rows, setRows] = useState(shares);
    const [pending, startTransition] = useTransition();
    const [busy, setBusy] = useState<string | null>(null);

    function onRevoke(id: string) {
        if (!window.confirm("Revoke this link? It will stop working immediately.")) return;
        setBusy(id);
        startTransition(async () => {
            await revokeShareAction(id);
            setRows((prev) => prev.map((row) => (row.id === id ? { ...row, revokedAt: new Date().toISOString() } : row)));
            setBusy(null);
        });
    }

    if (rows.length === 0) {
        return (
            <Card>
                <CardBody className="p-8 text-center text-sm text-muted-foreground">
                    You have not shared anything yet. Use the share action on a file or folder in Drive.
                </CardBody>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-2">
            {rows.map((share) => {
                const state = status(share);
                const isDir = share.allowUpload || share.path.endsWith("/");
                return (
                    <Card key={share.id}>
                        <CardBody className="flex flex-wrap items-center justify-between gap-3">
                            <div className="flex min-w-0 items-center gap-3">
                                {isDir ? (
                                    <FolderClosed className="size-4 shrink-0 text-primary" />
                                ) : (
                                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                                )}
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium">{share.path || "(root)"}</p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {share.connectionName}
                                        {share.maxDownloads !== null
                                            ? ` - ${share.downloadCount}/${share.maxDownloads} downloads`
                                            : ` - ${share.downloadCount} downloads`}
                                        {share.expiresAt
                                            ? ` - expires ${new Date(share.expiresAt).toLocaleDateString()}`
                                            : ""}
                                        {share.allowUpload ? " - drop box" : ""}
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <Badge variant={state.variant}>{state.label}</Badge>
                                {!share.revokedAt ? (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => onRevoke(share.id)}
                                        disabled={pending && busy === share.id}
                                    >
                                        <Ban className="size-4" />
                                        Revoke
                                    </Button>
                                ) : null}
                            </div>
                        </CardBody>
                    </Card>
                );
            })}
        </div>
    );
}
