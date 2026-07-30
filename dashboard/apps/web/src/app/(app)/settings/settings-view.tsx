"use client";

/**
 * Settings client view. Shows the deployment facts and the update card. The
 * update card starts from the server-rendered status and can be refreshed on
 * demand; the refresh forces a fresh GitHub comparison via the server action.
 */

import { useEffect, useRef, useState, useTransition } from "react";
import { Bug, CheckCircle2, DownloadCloud, RefreshCw, TriangleAlert } from "lucide-react";
import { Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import type { UpdateStatus } from "@/lib/update-service";
import { isRecentRun, isUpdateInFlight, type UpdateLogTail } from "@/lib/update-log";
import { checkUpdatesAction, triggerHostUpdateAction, updateReportAction } from "./actions";

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

/** How much of a finished run's log to show. Matches the endpoint's chunk cap, so
 *  the tail arrives in one read. */
const TAIL_BYTES = 128 * 1024;

/** How a run ended. A null code is a run that reported none - unknown, which is
 *  neither a success nor a failure and must not be offered as a bug report. */
interface UpdateResult {
    readonly code: number | null;
}

/** Only a code the updater actually reported can be called a failure. */
function isFailure(result: UpdateResult | null): boolean {
    return result !== null && result.code !== null && result.code !== 0;
}

function outcomeLabel(result: UpdateResult): string {
    if (result.code === null) return "no result reported";
    return result.code === 0 ? "success" : `failed (exit ${result.code})`;
}

function outcomeTone(result: UpdateResult): string {
    if (result.code === null) return "text-muted-foreground";
    return result.code === 0 ? "text-success" : "text-danger";
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
    const [updating, setUpdating] = useState(false);
    const [updateMsg, setUpdateMsg] = useState<string | null>(null);
    const [showManual, setShowManual] = useState(false);
    // Live update log, streamed from the shared file the updater writes.
    const [logText, setLogText] = useState("");
    const [logResult, setLogResult] = useState<UpdateResult | null>(null);
    const [reporting, setReporting] = useState(false);
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

    // An update runs on the host, not in this tab: reloading or navigating away
    // drops the local state while the updater keeps going, and the update itself
    // restarts the web container, so the page that started one rarely survives it.
    // The shared log file is the only truth - on mount, re-attach to a run still
    // being written, and show the outcome of one that has just ended. Without the
    // second case the card comes back idle after any update, offering the same one
    // again with nothing to say it already ran.
    useEffect(() => {
        void (async () => {
            try {
                const data = await fetchTail(0);
                if (!data) return;
                if (isUpdateInFlight(data, data.now)) {
                    setUpdating(true);
                    setUpdateMsg("Update in progress - reconnecting automatically when Polaris is back.");
                    pollLogs();
                    waitForUpdate();
                    return;
                }
                if (isRecentRun(data, data.now)) await showFinishedRun(data);
            } catch {
                // No log to re-attach to; leave the card in its idle state.
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /** One poll of the shared log. Null when it cannot be read right now. */
    async function fetchTail(offset: number): Promise<UpdateLogTail | null> {
        const res = await fetch(`/api/updates/logs?offset=${offset}`, { cache: "no-store" });
        if (!res.ok) return null;
        return (await res.json()) as UpdateLogTail;
    }

    /**
     * Render a run that ended before this page loaded.
     *
     * The end of the log is what matters - the error that killed a build is its
     * last lines - so it is asked for directly rather than walked to from the
     * start, which on a long build ran out of reads before ever arriving and left
     * the beginning of a successful compile on screen instead.
     *
     * A run that reported no exit code is shown as exactly that. It is either a
     * build still running quietly or one that died, and the log cannot tell them
     * apart, so it is not called either.
     */
    async function showFinishedRun(first: UpdateLogTail): Promise<void> {
        let text = first.content;
        if (first.size > first.nextOffset) {
            const tail = await fetchTail(Math.max(0, first.size - TAIL_BYTES));
            // Drop the partial first line: the offset is a byte count, so it lands
            // wherever it lands.
            if (tail?.exists) text = tail.content.slice(tail.content.indexOf("\n") + 1);
        }
        setLogText(text.replace(/POLARIS_UPDATE_EXIT=-?\d+\s*/g, ""));
        setLogResult({ code: first.exitCode });
        const at = new Date(first.updatedAt).toLocaleTimeString();
        setUpdateMsg(
            first.exitCode === 0
                ? `Last update finished at ${at}.`
                : first.exitCode === null
                  ? `An update was running at ${at} and never reported a result. It may still be going, or it may have been cut off.`
                  : `The last update failed (exit code ${first.exitCode}). See the log below.`
        );
    }

    /**
     * Open the prefilled issue. The tab is claimed before the await, because a
     * window opened after one is a popup as far as the browser is concerned - and
     * the report would be silently blocked on the click that asked for it.
     */
    async function onReport() {
        setReporting(true);
        const tab = window.open("", "_blank", "noopener");
        try {
            const { url } = await updateReportAction();
            if (tab) tab.location.href = url;
            else window.location.href = url;
        } catch {
            tab?.close();
            setUpdateMsg("Could not prepare the report. The log above can be attached to an issue by hand.");
        } finally {
            setReporting(false);
        }
    }

    async function onUpdate() {
        setUpdating(true);
        setUpdateMsg(null);
        setShowManual(false);
        const { status: result } = await triggerHostUpdateAction();
        if (result === "started") {
            setUpdateMsg("Update started - streaming the log below. This page reconnects automatically when Polaris is back.");
            setLogText("");
            setLogResult(null);
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
                const data = await fetchTail(offset);
                if (!data) return; // transient (or web restarting); keep trying
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
                    setLogResult({ code: data.exitCode });
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
        <div className="flex w-full flex-col gap-4">
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

                    {behind || updating || logText ? (
                        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                            {behind ? (
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
                            ) : null}
                            {updateMsg ? <p className="text-foreground">{updateMsg}</p> : null}
                            {showManual ? (
                                <p>
                                    Run <code className="text-foreground">polaris update</code> on the host to pull the
                                    latest image and redeploy.
                                </p>
                            ) : null}
                            {/* Rendered on the outcome as well as the text: a run cut
                                off before its first line of output has none, and
                                hiding the block would take the report button with it. */}
                            {updating || logText || logResult ? (
                                <div className="flex flex-col gap-1">
                                    <div className="flex items-center gap-2">
                                        <span className="font-medium text-foreground">Update log</span>
                                        {updating && !logResult ? (
                                            <RefreshCw className="size-3 animate-spin text-muted-foreground" />
                                        ) : null}
                                        {logResult ? (
                                            <span className={outcomeTone(logResult)}>{outcomeLabel(logResult)}</span>
                                        ) : null}
                                        {isFailure(logResult) ? (
                                            <Button
                                                size="sm"
                                                variant="secondary"
                                                className="ml-auto"
                                                onClick={onReport}
                                                disabled={reporting}
                                            >
                                                <Bug className="size-3.5" />
                                                {reporting ? "Preparing..." : "Report this failure"}
                                            </Button>
                                        ) : null}
                                    </div>
                                    {isFailure(logResult) ? (
                                        <p>
                                            Opens a prefilled issue with this log, your build, server type and domain.
                                            Nothing is sent until you submit it.
                                        </p>
                                    ) : null}
                                    <pre
                                        ref={logRef}
                                        className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-foreground/[0.04] p-2 font-mono text-[11px] leading-relaxed text-foreground"
                                    >
                                        {logText || (logResult ? "The updater wrote nothing." : "Waiting for the updater to start...")}
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
