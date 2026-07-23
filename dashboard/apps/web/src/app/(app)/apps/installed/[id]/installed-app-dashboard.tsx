"use client";

/**
 * Dashboard shell for an installed app: lifecycle controls, an app-specific panel
 * keyed by the catalog id, and the runtime log (reusing Deploy's log endpoint and
 * the shared LogViewer). Apps with an adapted panel lead with it and keep the raw
 * log as a collapsible secondary section, so opening the app is not just a wall of
 * logs; apps without one show the log directly.
 */

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ChevronDown, ChevronRight, Loader2, Play, RefreshCw, Square, Trash2 } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    PageHeader,
    cn
} from "@polaris/ui";
import { LogViewer } from "@/components/log-viewer";
import type { InstalledAppDetail } from "@/lib/apps/install-service";
import { MessagingBridgePanel } from "./messaging-bridge-panel";
import {
    redeployInstalledAppAction,
    setInstalledAppRunningAction,
    uninstallInstalledAppAction
} from "./actions";

const STATUS_LABEL: Record<string, string> = {
    installing: "Installing",
    running: "Running",
    stopped: "Stopped",
    failed: "Failed"
};

export function InstalledAppDashboard({ app }: { app: InstalledAppDetail }) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [confirmingUninstall, setConfirmingUninstall] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [log, setLog] = useState("");

    const running = app.applicationStatus === "running";
    const applicationId = app.applicationId;
    // Apps with an adapted panel lead with it and fold the raw log away by default.
    const adaptedPanel = app.catalogId === "messaging-bridge" ? <MessagingBridgePanel /> : null;
    const [showLogs, setShowLogs] = useState(adaptedPanel === null);

    const loadLog = useCallback(async () => {
        if (!applicationId) return;
        try {
            const response = await fetch(`/api/deploy/apps/${applicationId}/logs?tail=500`, { cache: "no-store" });
            if (!response.ok) return;
            const data = (await response.json()) as { log?: string };
            setLog(data.log ?? "");
        } catch {
            // Transient; the next poll retries.
        }
    }, [applicationId]);

    // Poll the runtime log while the app is running and the log is visible, like the
    // Deploy logs tab. Skipped when the log is collapsed so a healthy app is not
    // polled for output nobody is looking at.
    useEffect(() => {
        if (!applicationId || !running || !showLogs) return;
        void loadLog();
        const timer = setInterval(loadLog, 4000);
        return () => clearInterval(timer);
    }, [applicationId, running, showLogs, loadLog]);

    function run(action: () => Promise<{ error?: string }>) {
        setError(null);
        startTransition(async () => {
            const result = await action();
            if (result.error) {
                setError(result.error);
                return;
            }
            router.refresh();
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <Link
                href="/apps/marketplace"
                className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
                <ArrowLeft className="size-4" /> Marketplace
            </Link>

            <PageHeader
                title={app.name}
                description={[app.catalogName, app.serverName].filter(Boolean).join(" - ")}
                actions={
                    <div className="flex items-center gap-2">
                        <Badge
                            className={cn(
                                app.applicationStatus === "failed" && "border-danger/40 text-danger",
                                running && "border-success/40 text-success"
                            )}
                        >
                            {app.applicationStatus ? (STATUS_LABEL[app.applicationStatus] ?? app.applicationStatus) : "-"}
                        </Badge>
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => run(() => setInstalledAppRunningAction(app.id, !running))}
                            disabled={pending || !applicationId}
                        >
                            {running ? <Square className="size-4" /> : <Play className="size-4" />}
                            {running ? "Stop" : "Start"}
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => run(() => redeployInstalledAppAction(app.id))}
                            disabled={pending || !applicationId}
                        >
                            <RefreshCw className="size-4" /> Redeploy
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmingUninstall(true)}
                            disabled={pending}
                        >
                            <Trash2 className="size-4" /> Uninstall
                        </Button>
                    </div>
                }
            />

            {error && <p className="text-sm text-danger">{error}</p>}

            {adaptedPanel}

            <Card>
                <CardBody className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                        <button
                            type="button"
                            onClick={() => setShowLogs((value) => !value)}
                            className="flex items-center gap-1 text-sm font-medium hover:text-foreground"
                        >
                            {showLogs ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                            Runtime logs
                        </button>
                        {showLogs && (
                            <Button size="sm" variant="ghost" onClick={() => void loadLog()} disabled={!applicationId}>
                                <RefreshCw className="size-4" /> Refresh
                            </Button>
                        )}
                    </div>
                    {showLogs && (
                        <LogViewer
                            log={log}
                            name={app.name}
                            searchable
                            emptyText={running ? "Waiting for output..." : "The app is not running."}
                            className="h-80"
                        />
                    )}
                </CardBody>
            </Card>

            <Dialog open={confirmingUninstall} onOpenChange={setConfirmingUninstall}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Uninstall {app.name}?</DialogTitle>
                        <DialogDescription>
                            This tears down its container and removes it from your apps. Data on server-local volumes is
                            lost; data on a NAS mount is kept.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => setConfirmingUninstall(false)} disabled={pending}>
                            Cancel
                        </Button>
                        <Button
                            variant="danger"
                            onClick={() =>
                                startTransition(async () => {
                                    const result = await uninstallInstalledAppAction(app.id);
                                    if (result.error) {
                                        setError(result.error);
                                        setConfirmingUninstall(false);
                                        return;
                                    }
                                    router.push("/apps/marketplace");
                                })
                            }
                            disabled={pending}
                        >
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            Uninstall
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
