"use client";

/**
 * Drop-points list. A search box filters by title, destination, or connection.
 * Each row links to the drop point's detail page (collected files, config,
 * visitors); inline Close/Reopen actions sit outside the row link so clicking
 * them does not navigate. The public link is never shown here - only its hash is
 * stored.
 */

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Ban, Inbox, Lock, RotateCcw, Search } from "lucide-react";
import { Badge, Button, Card, CardBody, Input } from "@polaris/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { reopenFileRequestAction, revokeFileRequestAction } from "../request-actions";

export interface DropPointRow {
    id: string;
    title: string;
    destinationPath: string;
    connectionName: string;
    requireLogin: boolean;
    maxFiles: number | null;
    submissionCount: number;
    startsAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
}

function status(request: DropPointRow): {
    label: string;
    variant: "success" | "neutral" | "warning";
} {
    if (request.revokedAt) return { label: "Closed", variant: "neutral" };
    if (request.startsAt && new Date(request.startsAt).getTime() > Date.now()) {
        return { label: "Scheduled", variant: "warning" };
    }
    if (request.expiresAt && new Date(request.expiresAt).getTime() <= Date.now()) {
        return { label: "Expired", variant: "warning" };
    }
    if (request.maxFiles !== null && request.submissionCount >= request.maxFiles) {
        return { label: "Full", variant: "warning" };
    }
    return { label: "Open", variant: "success" };
}

export function DropPointsView({ requests }: { requests: DropPointRow[] }) {
    const [rows, setRows] = useState(requests);
    const [query, setQuery] = useState("");
    const [pending, startTransition] = useTransition();
    const [busy, setBusy] = useState<string | null>(null);
    const [confirm, confirmDialog] = useConfirm();

    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return rows;
        return rows.filter((row) =>
            [row.title, row.connectionName, row.destinationPath]
                .join(" ")
                .toLowerCase()
                .includes(needle)
        );
    }, [rows, query]);

    async function onRevoke(id: string) {
        if (
            !(await confirm({
                title: "Close this drop point?",
                description: "It will stop accepting uploads immediately.",
                confirmLabel: "Close",
                danger: true
            }))
        )
            return;
        setBusy(id);
        startTransition(async () => {
            await revokeFileRequestAction(id);
            setRows((prev) =>
                prev.map((row) =>
                    row.id === id ? { ...row, revokedAt: new Date().toISOString() } : row
                )
            );
            setBusy(null);
        });
    }

    function onReopen(id: string) {
        setBusy(id);
        startTransition(async () => {
            await reopenFileRequestAction(id);
            setRows((prev) =>
                prev.map((row) => (row.id === id ? { ...row, revokedAt: null } : row))
            );
            setBusy(null);
        });
    }

    if (rows.length === 0) {
        return (
            <Card>
                <CardBody className="p-8 text-center text-sm text-muted-foreground">
                    No drop points yet. Use &quot;New drop point&quot; above, or &quot;Request
                    files&quot; on a folder in Files.
                </CardBody>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search drop points"
                    className="pl-9"
                />
            </div>

            {filtered.length === 0 ? (
                <Card>
                    <CardBody className="p-6 text-center text-sm text-muted-foreground">
                        No drop points match &quot;{query}&quot;.
                    </CardBody>
                </Card>
            ) : (
                <div className="flex flex-col gap-2">
                    {filtered.map((request) => {
                        const state = status(request);
                        const scheduled =
                            request.startsAt && new Date(request.startsAt).getTime() > Date.now();
                        return (
                            <Card key={request.id}>
                                <CardBody className="flex flex-wrap items-center justify-between gap-3">
                                    <Link
                                        href={`/drive/drop-points/${request.id}`}
                                        className="flex min-w-0 flex-1 items-center gap-3 rounded-md transition-colors hover:opacity-80"
                                    >
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
                                                {request.destinationPath
                                                    ? ` / ${request.destinationPath}`
                                                    : ""}
                                                {` - ${request.submissionCount}`}
                                                {request.maxFiles !== null
                                                    ? `/${request.maxFiles}`
                                                    : ""}{" "}
                                                uploaded
                                                {scheduled && request.startsAt
                                                    ? ` - opens ${new Date(request.startsAt).toLocaleDateString()}`
                                                    : request.expiresAt
                                                      ? ` - until ${new Date(request.expiresAt).toLocaleDateString()}`
                                                      : ""}
                                            </p>
                                        </div>
                                    </Link>
                                    <div className="flex items-center gap-2">
                                        <Badge variant={state.variant}>{state.label}</Badge>
                                        {request.revokedAt ? (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => onReopen(request.id)}
                                                disabled={pending && busy === request.id}
                                            >
                                                <RotateCcw className="size-4" />
                                                Reopen
                                            </Button>
                                        ) : (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => onRevoke(request.id)}
                                                disabled={pending && busy === request.id}
                                            >
                                                <Ban className="size-4" />
                                                Close
                                            </Button>
                                        )}
                                    </div>
                                </CardBody>
                            </Card>
                        );
                    })}
                </div>
            )}
            {confirmDialog}
        </div>
    );
}
