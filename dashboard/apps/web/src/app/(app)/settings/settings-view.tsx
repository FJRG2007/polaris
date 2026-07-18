"use client";

/**
 * Settings client view. Shows the deployment facts and the update card. The
 * update card starts from the server-rendered status and can be refreshed on
 * demand; the refresh forces a fresh GitHub comparison via the server action.
 */

import { useState, useTransition } from "react";
import { CheckCircle2, DownloadCloud, RefreshCw, TriangleAlert } from "lucide-react";
import { Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import type { UpdateStatus } from "@/lib/update-service";
import { checkUpdatesAction } from "./actions";

interface Deployment {
    readonly appUrl: string;
    readonly hostname: string;
    readonly repo: string;
    readonly branch: string;
    readonly autoUpdate: boolean;
}

function formatChecked(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "never" : date.toLocaleString();
}

export function SettingsView({
    initialStatus,
    deployment
}: {
    initialStatus: UpdateStatus;
    deployment: Deployment;
}) {
    const [status, setStatus] = useState(initialStatus);
    const [pending, startTransition] = useTransition();

    function onCheck() {
        startTransition(async () => {
            setStatus(await checkUpdatesAction());
        });
    }

    const behind = typeof status.behindBy === "number" && status.behindBy > 0;

    return (
        <div className="flex max-w-2xl flex-col gap-4">
            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                        <CardTitle>Updates</CardTitle>
                        <Button size="sm" variant="secondary" onClick={onCheck} disabled={pending}>
                            <RefreshCw className={`size-4 ${pending ? "animate-spin" : ""}`} />
                            {pending ? "Checking..." : "Check for updates"}
                        </Button>
                    </div>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex items-center gap-2 text-sm">
                        {status.error ? (
                            <>
                                <TriangleAlert className="size-4 text-warning" />
                                <span className="text-warning">{status.error}</span>
                            </>
                        ) : behind ? (
                            <>
                                <DownloadCloud className="size-4 text-primary" />
                                <span>
                                    Update available - {status.behindBy} commit{status.behindBy === 1 ? "" : "s"}{" "}
                                    behind {deployment.branch}.
                                </span>
                            </>
                        ) : status.upToDate ? (
                            <>
                                <CheckCircle2 className="size-4 text-success" />
                                <span>Up to date.</span>
                            </>
                        ) : (
                            <>
                                <TriangleAlert className="size-4 text-muted-foreground" />
                                <span className="text-muted-foreground">
                                    Update state unknown (this build carries no commit reference).
                                </span>
                            </>
                        )}
                    </div>

                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                        <Row label="Running build" value={status.current ?? "unknown"} />
                        <Row label="Latest" value={status.latest ?? "-"} />
                        <Row label="Auto-update" value={deployment.autoUpdate ? "enabled" : "disabled"} />
                        <Row label="Last checked" value={formatChecked(status.checkedAt)} />
                    </dl>

                    {behind ? (
                        <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                            Run <code className="text-foreground">polaris update</code> on the host to pull the latest
                            image and redeploy.{" "}
                            <a className="text-primary hover:underline" href={status.url} target="_blank" rel="noreferrer">
                                View changes
                            </a>
                        </div>
                    ) : null}
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Deployment</CardTitle>
                </CardHeader>
                <CardBody>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                        <Row label="App URL" value={deployment.appUrl} />
                        <Row label="Local hostname" value={`${deployment.hostname}.local`} />
                        <Row label="Repository" value={deployment.repo} />
                        <Row label="Release branch" value={deployment.branch} />
                    </dl>
                </CardBody>
            </Card>
        </div>
    );
}

function Row({ label, value }: { label: string; value: string }) {
    return (
        <>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate font-medium">{value}</dd>
        </>
    );
}
