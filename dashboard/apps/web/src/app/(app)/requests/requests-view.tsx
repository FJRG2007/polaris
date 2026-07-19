"use client";

/**
 * Manage-drop-points view. Lists the current user's file requests with their
 * limits and submission counts, and lets them revoke one. Mirrors the shared-
 * links view; the link is not shown here because only its hash is stored.
 */

import { useState, useTransition } from "react";
import { Ban, Inbox, Lock } from "lucide-react";
import { Badge, Button, Card, CardBody } from "@polaris/ui";
import { revokeFileRequestAction } from "../drive/request-actions";

export interface RequestRow {
    id: string;
    title: string;
    destinationPath: string;
    connectionName: string;
    requireLogin: boolean;
    maxFiles: number | null;
    submissionCount: number;
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
}

function status(request: RequestRow): { label: string; variant: "success" | "neutral" | "warning" } {
    if (request.revokedAt) return { label: "Closed", variant: "neutral" };
    if (request.expiresAt && new Date(request.expiresAt).getTime() <= Date.now()) {
        return { label: "Expired", variant: "warning" };
    }
    if (request.maxFiles !== null && request.submissionCount >= request.maxFiles) {
        return { label: "Full", variant: "warning" };
    }
    return { label: "Open", variant: "success" };
}

export function RequestsView({ requests }: { requests: RequestRow[] }) {
    const [rows, setRows] = useState(requests);
    const [pending, startTransition] = useTransition();
    const [busy, setBusy] = useState<string | null>(null);

    function onRevoke(id: string) {
        if (!window.confirm("Close this drop point? It will stop accepting uploads immediately.")) return;
        setBusy(id);
        startTransition(async () => {
            await revokeFileRequestAction(id);
            setRows((prev) =>
                prev.map((row) => (row.id === id ? { ...row, revokedAt: new Date().toISOString() } : row))
            );
            setBusy(null);
        });
    }

    if (rows.length === 0) {
        return (
            <Card>
                <CardBody className="p-8 text-center text-sm text-muted-foreground">
                    No drop points yet. Use &quot;Request files&quot; on a folder in Files to create one.
                </CardBody>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-2">
            {rows.map((request) => {
                const state = status(request);
                return (
                    <Card key={request.id}>
                        <CardBody className="flex flex-wrap items-center justify-between gap-3">
                            <div className="flex min-w-0 items-center gap-3">
                                <Inbox className="size-4 shrink-0 text-primary" />
                                <div className="min-w-0">
                                    <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                                        {request.title}
                                        {request.requireLogin ? (
                                            <Lock className="size-3 text-muted-foreground" />
                                        ) : null}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {request.connectionName}
                                        {request.destinationPath ? ` / ${request.destinationPath}` : ""}
                                        {` - ${request.submissionCount}`}
                                        {request.maxFiles !== null ? `/${request.maxFiles}` : ""} uploaded
                                        {request.expiresAt
                                            ? ` - until ${new Date(request.expiresAt).toLocaleDateString()}`
                                            : ""}
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <Badge variant={state.variant}>{state.label}</Badge>
                                {!request.revokedAt ? (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => onRevoke(request.id)}
                                        disabled={pending && busy === request.id}
                                    >
                                        <Ban className="size-4" />
                                        Close
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
