"use client";

/**
 * Settings client view. Shows the deployment facts and the update card. The
 * update card starts from the server-rendered status and can be refreshed on
 * demand; the refresh forces a fresh GitHub comparison via the server action.
 */

import { useEffect, useRef, useState, useTransition } from "react";
import { CheckCircle2, DownloadCloud, RefreshCw, TriangleAlert } from "lucide-react";
import { Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import type { UpdateStatus } from "@/lib/update-service";
import { checkUpdatesAction, triggerHostUpdateAction } from "./actions";

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

// Last auto-check timestamp, module-level so the 30s throttle survives navigating
// away and back within the session.
let lastAutoCheck = 0;

export function SettingsView({
    initialStatus,
    deployment
}: {
    initialStatus: UpdateStatus;
    deployment: Deployment;
}) {
    const [status, setStatus] = useState(initialStatus);
    const [pending, startTransition] = useTransition();
    const [updating, setUpdating] = useState(false);
    const [updateMsg, setUpdateMsg] = useState<string | null>(null);
    const [showManual, setShowManual] = useState(false);
    // Live update log, streamed from the shared file the updater writes.
    const [logText, setLogText] = useState("");
    const [logExit, setLogExit] = useState<number | null>(null);
    const logRef = useRef<HTMLPreElement>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const waitRef = useRef<ReturnType<typeof setInterval> | null>(null);

    function onCheck() {
        startTransition(async () => {
            setStatus(await checkUpdatesAction());
        });
    }

    // Auto-check on entering the page, throttled to once per 30s across visits so
    // opening Settings always shows a fresh result without a manual click.
    useEffect(() => {
        if (Date.now() - lastAutoCheck > 30_000) {
            lastAutoCheck = Date.now();
            onCheck();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function onUpdate() {
        setUpdating(true);
        setUpdateMsg(null);
        setShowManual(false);
        const { status: result } = await triggerHostUpdateAction();
        if (result === "started") {
            setUpdateMsg("Update started - streaming the log below. This page reconnects automatically when Polaris is back.");
            setLogText("");
            setLogExit(null);
            pollLogs();
            // Also watch health: the web restarts on the new build during the update,
            // which reloads the page even if the log marker is missed - so the card
            // never stays stuck on "Updating..." until a manual restart.
            waitForUpdate();
            return; // stay in the updating state; completion reloads via marker or health
        }
        setUpdating(false);
        if (result === "unavailable") {
            setUpdateMsg("The host agent has no update command set (POLARIS_HOSTD_UPDATE_CMD). Use the manual command for now.");
            setShowManual(true);
        } else if (result === "disabled") {
            setUpdateMsg("Auto-update is disabled on this host.");
            setShowManual(true);
        } else {
            setUpdateMsg("Couldn't reach the host agent. Use the manual command below.");
            setShowManual(true);
        }
    }

    // The web container restarts during an update; poll the cheap local health
    // endpoint (no GitHub calls), and once it has gone down and come back healthy
    // on the new build, reload. Keeps downtime visible and self-heals the page.
    // Runs in parallel with the log tail as the reliable completion signal: the web
    // container is recreated during an update, so once it has gone down and come
    // back healthy on the new build the update is effectively done - reload so the
    // page re-reads the fresh status. This fixes the stuck "Updating..." when the
    // log's completion marker is missed or its file is lost on the recreate.
    // Idempotent: only one health watcher runs at a time.
    function waitForUpdate(): void {
        if (waitRef.current) return;
        let sawDown = false;
        let tries = 0;
        waitRef.current = setInterval(async () => {
            tries += 1;
            try {
                const res = await fetch("/api/health", { cache: "no-store" });
                if (res.ok) {
                    if (sawDown) {
                        stopPolling();
                        setUpdateMsg("Updated - reloading...");
                        window.location.reload();
                    }
                } else {
                    sawDown = true;
                }
            } catch {
                sawDown = true;
            }
            if (tries >= 150) {
                stopPolling();
                setUpdating(false);
                setUpdateMsg("Update is taking longer than expected. Refresh the page manually.");
            }
        }, 2000);
    }

    function stopPolling(): void {
        if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
        }
        if (waitRef.current) {
            clearInterval(waitRef.current);
            waitRef.current = null;
        }
    }

    // Tail the shared update log by byte offset, so progress streams live and the
    // poll simply resumes after the web container is recreated mid-update. Stops on
    // the completion marker (reloads on success, shows the log on failure). If no
    // shared log exists yet - the case on the first update after this ships, before
    // the log redirect is in .env - fall back to the health-based reload.
    function pollLogs(): void {
        let offset = 0;
        let missing = 0;
        let sawContent = false;
        let acc = "";
        stopPolling();
        pollRef.current = setInterval(async () => {
            try {
                const res = await fetch(`/api/updates/logs?offset=${offset}`, { cache: "no-store" });
                if (!res.ok) return; // transient (or web restarting); keep trying
                const data = (await res.json()) as {
                    exists: boolean;
                    content: string;
                    nextOffset: number;
                    done: boolean;
                    exitCode: number | null;
                };
                if (!data.exists) {
                    missing += 1;
                    if (missing >= 4 && !sawContent) {
                        stopPolling();
                        setUpdateMsg("Updating - live logs will show from the next update. Reconnecting when Polaris is back...");
                        waitForUpdate();
                    }
                    return;
                }
                offset = data.nextOffset;
                if (data.content) {
                    sawContent = true;
                    acc += data.content;
                    const clean = data.content.replace(/POLARIS_UPDATE_EXIT=-?\d+\s*/g, "");
                    if (clean) setLogText((prev) => prev + clean);
                }
                if (data.done) {
                    stopPolling();
                    setLogExit(data.exitCode);
                    if (data.exitCode === 0) {
                        setUpdateMsg("Update complete - reloading...");
                        setTimeout(() => window.location.reload(), 1200);
                    } else {
                        setUpdating(false);
                        setUpdateMsg(`Update failed (exit code ${data.exitCode ?? "unknown"}). See the log below.`);
                    }
                    return;
                }
                // Fallback for when the exit marker never arrives (e.g. an older
                // updater): the installer prints this line only on success. Detecting
                // it means the update finished even if the web container never
                // restarted, so the card does not stay stuck on "Updating...".
                if (/Polaris is running at|POLARIS_UPDATE_EXIT=0/.test(acc)) {
                    stopPolling();
                    setUpdateMsg("Update complete - reloading...");
                    setTimeout(() => window.location.reload(), 1500);
                }
            } catch {
                // Web is restarting mid-update; keep polling until it returns.
            }
        }, 1200);
    }

    // Keep the log view scrolled to the newest line as it streams.
    useEffect(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    }, [logText]);

    // Stop the interval if the page unmounts mid-update.
    useEffect(() => stopPolling, []);

    const behind = typeof status.behindBy === "number" && status.behindBy > 0;

    return (
        <div className="flex max-w-2xl flex-col gap-4">
            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                        <CardTitle>Updates</CardTitle>
                        <Button size="sm" variant="secondary" onClick={onCheck} disabled={pending || updating}>
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
                        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                            <div className="flex items-center justify-between gap-2">
                                <span>
                                    An update is available.{" "}
                                    <a
                                        className="text-primary hover:underline"
                                        href={status.url}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        View changes
                                    </a>
                                </span>
                                <Button size="sm" onClick={onUpdate} disabled={updating}>
                                    {updating ? <RefreshCw className="size-4 animate-spin" /> : <DownloadCloud className="size-4" />}
                                    {updating ? "Updating..." : "Update now"}
                                </Button>
                            </div>
                            {updateMsg ? <p className="text-foreground">{updateMsg}</p> : null}
                            {showManual ? (
                                <p>
                                    Run <code className="text-foreground">polaris update</code> on the host to pull the
                                    latest image and redeploy.
                                </p>
                            ) : null}
                            {updating || logText ? (
                                <div className="flex flex-col gap-1">
                                    <div className="flex items-center gap-2">
                                        <span className="font-medium text-foreground">Update log</span>
                                        {updating && logExit === null ? (
                                            <RefreshCw className="size-3 animate-spin text-muted-foreground" />
                                        ) : null}
                                        {logExit !== null ? (
                                            <span className={logExit === 0 ? "text-success" : "text-danger"}>
                                                {logExit === 0 ? "success" : `failed (exit ${logExit})`}
                                            </span>
                                        ) : null}
                                    </div>
                                    <pre
                                        ref={logRef}
                                        className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-foreground/[0.04] p-2 font-mono text-[11px] leading-relaxed text-foreground"
                                    >
                                        {logText || "Waiting for the updater to start..."}
                                    </pre>
                                </div>
                            ) : null}
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
