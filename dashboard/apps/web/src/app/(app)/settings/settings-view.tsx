"use client";

/**
 * Settings client view: the deployment facts and the update card.
 *
 * The card has one job beyond starting an update - always saying what is actually
 * happening. It used to read "Up to date" while an update was running underneath
 * it, because the status line only ever described the last GitHub check. Here the
 * running update outranks the check: while one is in flight the line reports the
 * step it is on, taken from the log itself.
 *
 * An update outlives the tab that started it (it restarts the dashboard), so none
 * of this is kept in local state: the shared log file says whether a run is in
 * flight, and the build reported by whichever container answers the poll says when
 * a new one has taken over.
 */

import { LogViewer } from "@/components/log-viewer";
import { CopyButton } from "@/components/copy-button";
import type { UpdateStatus } from "@/lib/update-service";
import type { CheckedAddress } from "@/lib/address-health";
import { useDisplayFormat } from "@/components/display-format";
import { useEffect, useRef, useState, useTransition } from "react";
import { isRecentRun, isUpdateInFlight, type UpdateLogTail } from "@/lib/update-log";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, Select } from "@polaris/ui";
import type { AutoUpdateMode, AutoUpdatePolicy, DisplayFormat, UpdateSource } from "@polaris/core";
import { Bug, CheckCircle2, CircleDashed, DownloadCloud, ExternalLink, Hammer, RefreshCw, TriangleAlert } from "lucide-react";
import {
    checkUpdatesAction,
    saveAutoUpdateAction,
    saveUpdateSourceAction,
    triggerHostUpdateAction,
    updateReportAction
} from "./actions";

interface Deployment {
    readonly addresses: CheckedAddress[];
    readonly hostname: string;
    readonly repo: string;
    readonly branch: string;
    readonly autoUpdate: boolean;
}

/** What each kind of address is, said once next to it. */
const ADDRESS_KINDS: Record<CheckedAddress["kind"], string> = {
    app: "configured at install",
    local: "local network",
    domain: "domain",
    tunnel: "tunnel"
};

/** Why an address is marked down, and how long ago that was found out. */
function downDetail(health: CheckedAddress["health"], format: DisplayFormat): string {
    const checked = health.checkedAt ? new Date(health.checkedAt) : null;
    const when = checked && !Number.isNaN(checked.getTime()) ? `, checked ${format.dateTime(checked)}` : "";
    return `${health.detail ?? "Nothing answered"}${when}`;
}

const SOURCE_CHOICES: { value: UpdateSource; label: string; }[] = [
    { value: "image", label: "Published build" },
    { value: "build", label: "Build on this host" }
];

function sourceHint(source: UpdateSource): string {
    if (source === "build") {
        return "Advances the checkout on the host and builds the image there. Slower, and it needs room to build, but it installs the branch as it stands instead of waiting for a published build.";
    }
    return "Downloads the build GitHub already made. Fastest, and it is the build every other deployment runs.";
}

function formatChecked(iso: string, format: DisplayFormat): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "never" : format.dateTime(date);
}

// Last auto-check timestamp, module-level so the 30s throttle survives navigating
// away and back within the session.
let lastAutoCheck = 0;

/** How much of a finished run's log to show. Matches the endpoint's chunk cap, so
 *  the tail arrives in one read. */
const TAIL_BYTES = 128 * 1024;

/** The updater's completion marker, which is bookkeeping rather than output. */
const MARKER_RE = /^.*POLARIS_UPDATE_EXIT=-?\d+.*$\n?/gm;

const UPDATE_MODES: { value: AutoUpdateMode; label: string; }[] = [
    { value: "off", label: "Only tell me" },
    { value: "immediate", label: "As soon as one is published" },
    { value: "daily", label: "Every day at" }
];

/** A complete 24-hour time. The time field reports "" until one is typed. */
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

function scheduleHint(policy: AutoUpdatePolicy): string {
    if (policy.mode === "immediate") {
        return "A published build installs itself. The dashboard keeps serving while it rolls over.";
    }
    if (policy.mode === "daily") {
        return `Installs at the first ${policy.at} after a build appears. If Polaris is off then, it installs when it comes back.`;
    }
    return "Everyone who can update Polaris is told when a build is ready. Nothing installs on its own.";
}

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

/**
 * The step an update is on, read from the last thing it said. The updater prefixes
 * its own progress with `polaris:`, so those lines are the narration and everything
 * else (docker's own output) is detail - which is what makes this a step rather
 * than whatever scrolled past last.
 */
function currentStep(log: string): string | null {
    const lines = log.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const match = /polaris:\s*(.+?)\s*$/.exec(lines[index] ?? "");
        if (match?.[1]) return match[1];
    }
    return null;
}

export function SettingsView({
    initialStatus,
    initialPolicy,
    initialSource,
    deployment
}: {
    initialStatus: UpdateStatus;
    initialPolicy: AutoUpdatePolicy;
    initialSource: UpdateSource;
    deployment: Deployment;
}) {
    const format = useDisplayFormat();
    const [status, setStatus] = useState(initialStatus);
    const [policy, setPolicy] = useState(initialPolicy);
    const [source, setSource] = useState(initialSource);
    // What the time field shows. A time input empties itself between segments, so
    // it cannot be driven straight from the saved schedule without fighting the
    // person editing it.
    const [timeDraft, setTimeDraft] = useState(initialPolicy.at);
    const [policyError, setPolicyError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [updating, setUpdating] = useState(false);
    const [updateMsg, setUpdateMsg] = useState<string | null>(null);
    const [showManual, setShowManual] = useState(false);
    // Live update log, streamed from the shared file the updater writes.
    const [logText, setLogText] = useState("");
    const [logResult, setLogResult] = useState<UpdateResult | null>(null);
    const [reporting, setReporting] = useState(false);
    // The build that was serving when this run started. A different one answering
    // later means the new dashboard has taken over - the completion signal that
    // survives the updater being cut off by the restart it is performing.
    const startBuild = useRef<string | null>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const waitRef = useRef<ReturnType<typeof setInterval> | null>(null);

    function onCheck(force = true) {
        startTransition(async () => {
            setStatus(await checkUpdatesAction(force));
        });
    }

    /**
     * Change when updates install themselves. Applied to the control at once and
     * put back if the server refuses it, so the schedule never reads as saved
     * when it is not - this one decides when the deployment restarts.
     */
    async function onSchedule(next: AutoUpdatePolicy) {
        if (next.mode === policy.mode && next.at === policy.at) return;
        const previous = policy;
        setPolicy(next);
        setPolicyError(null);
        const { error } = await saveAutoUpdateAction(next);
        if (error) {
            setPolicy(previous);
            setTimeDraft(previous.at);
            setPolicyError(error);
        }
    }

    /**
     * Change where updates come from. The two answers do not describe the same
     * thing - one tracks a published image, the other the branch - so the status
     * is re-read rather than left saying what it meant a moment ago.
     */
    async function onSource(next: UpdateSource) {
        if (next === source) return;
        const previous = source;
        setSource(next);
        setPolicyError(null);
        const { error } = await saveUpdateSourceAction(next);
        if (error) {
            setSource(previous);
            setPolicyError(error);
            return;
        }
        onCheck(true);
    }

    // Refresh on entering the page, throttled to once per 30s across visits so
    // opening Settings always shows a current result without a manual click.
    useEffect(() => {
        if (Date.now() - lastAutoCheck > 30_000) {
            lastAutoCheck = Date.now();
            onCheck(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // An update runs on the host, not in this tab: reloading or navigating away
    // drops the local state while the updater keeps going, and the update itself
    // restarts the dashboard, so the page that started one rarely survives it.
    // The shared log file is the only truth - on mount, re-attach to a run still
    // being written, and show the outcome of one that has just ended. Without the
    // second case the card comes back idle after any update, offering the same one
    // again with nothing to say it already ran.
    useEffect(() => {
        void (async () => {
            try {
                const data = await fetchTail(0);
                if (!data) return;
                startBuild.current = data.build;
                if (isUpdateInFlight(data, data.now)) {
                    setUpdating(true);
                    setUpdateMsg("Reattached to an update already running.");
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
     * The end of the log is what matters - the error that killed a run is its last
     * lines - so it is asked for directly rather than walked to from the start,
     * which on a long run ran out of reads before ever arriving.
     *
     * A run that reported no exit code is shown as exactly that. It is either one
     * still going quietly or one that was cut off, and the log cannot tell them
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
        setLogText(text.replace(MARKER_RE, ""));
        setLogResult({ code: first.exitCode });
        const at = format.time(first.updatedAt);
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
        setLogText("");
        setLogResult(null);
        const { status: result } = await triggerHostUpdateAction();
        if (result === "started") {
            setUpdateMsg("The dashboard keeps serving while the new build starts; this page reloads when it takes over.");
            pollLogs();
            // Watch health as well: an older updater restarts the dashboard in place
            // instead of rolling it over, and that restart is then the only signal.
            waitForUpdate();
            return; // stay in the updating state; completion reloads the page
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

    // Fallback completion watcher, for an update that restarts the dashboard rather
    // than rolling it over: once it has gone down and come back, reload. Idempotent -
    // only one health watcher runs at a time.
    function waitForUpdate(): void {
        if (waitRef.current) return;
        let sawDown = false;
        let tries = 0;
        waitRef.current = setInterval(async () => {
            tries += 1;
            try {
                const res = await fetch("/api/health", { cache: "no-store" });
                if (res.ok) {
                    if (sawDown) finish("Updated - reloading...");
                } else {
                    sawDown = true;
                }
            } catch {
                sawDown = true;
            }
            if (tries >= 300) {
                stopPolling();
                setUpdating(false);
                setUpdateMsg("This is taking longer than expected. The log above is still the live one.");
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

    /** Stop everything and reload, so the page comes back on the new build. */
    function finish(message: string): void {
        stopPolling();
        setUpdateMsg(message);
        setTimeout(() => window.location.reload(), 1200);
    }

    // Tail the shared update log by byte offset, so progress streams live and the
    // poll simply resumes if the dashboard is recreated mid-update.
    function pollLogs(): void {
        let offset = 0;
        let missing = 0;
        let sawContent = false;
        stopPolling();
        pollRef.current = setInterval(async () => {
            try {
                const data = await fetchTail(offset);
                if (!data) return; // transient (or the dashboard restarting); keep trying
                if (!data.exists) {
                    missing += 1;
                    if (missing >= 4 && !sawContent) {
                        stopPolling();
                        setUpdateMsg("Updating - this host writes no live log. Reconnecting when Polaris is back...");
                        waitForUpdate();
                    }
                    return;
                }
                offset = data.nextOffset;
                if (data.content) {
                    sawContent = true;
                    const clean = data.content.replace(MARKER_RE, "");
                    if (clean) setLogText((prev) => prev + clean);
                }
                // A different build answering means the new dashboard is serving.
                // True whether it took over by rollover or by restart, and true even
                // if the updater never got to write its marker.
                if (data.build && startBuild.current && data.build !== startBuild.current) {
                    setLogResult({ code: 0 });
                    finish("The new build is serving - reloading...");
                    return;
                }
                if (!startBuild.current) startBuild.current = data.build;
                if (data.done) {
                    stopPolling();
                    setLogResult({ code: data.exitCode });
                    if (data.exitCode === 0) {
                        finish("Update complete - reloading...");
                    } else {
                        setUpdating(false);
                        setUpdateMsg(`Update failed (exit code ${data.exitCode ?? "unknown"}). See the log below.`);
                    }
                }
            } catch {
                // The dashboard is restarting mid-update; keep polling until it returns.
            }
        }, 1200);
    }

    // Stop the interval if the page unmounts mid-update.
    useEffect(() => stopPolling, []);

    const step = updating ? currentStep(logText) : null;
    const available = status.phase === "available";

    return (
        <div className="flex w-full flex-col gap-4">
            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                        <CardTitle>Updates</CardTitle>
                        <Button size="sm" variant="secondary" onClick={() => onCheck()} disabled={pending || updating}>
                            <RefreshCw className={`size-4 ${pending ? "animate-spin" : ""}`} />
                            {pending ? "Checking..." : "Check for updates"}
                        </Button>
                    </div>
                </CardHeader>
                <CardBody className="flex flex-col gap-3">
                    {/* A running update outranks the last check: reporting "Up to date"
                        while one is in flight is the card contradicting itself. */}
                    <div className="flex items-center gap-2 text-sm">
                        {updating ? (
                            <>
                                <RefreshCw className="size-4 animate-spin text-primary" />
                                <span>Updating{step ? ` - ${step}` : "..."}</span>
                            </>
                        ) : status.error ? (
                            <>
                                <TriangleAlert className="size-4 text-warning" />
                                <span className="text-warning">{status.error}</span>
                            </>
                        ) : available ? (
                            <>
                                <DownloadCloud className="size-4 text-primary" />
                                <span>
                                    Update available
                                    {typeof status.behindBy === "number" && status.behindBy > 0
                                        ? ` - ${status.behindBy} commit${status.behindBy === 1 ? "" : "s"} behind ${deployment.branch}.`
                                        : "."}
                                </span>
                            </>
                        ) : status.phase === "blocked" ? (
                            <>
                                <TriangleAlert className="size-4 text-warning" />
                                <span>
                                    The newest commit failed its checks, so it is not offered to install.{" "}
                                    {status.checksUrl ? (
                                        <a
                                            className="text-primary hover:underline"
                                            href={status.checksUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                        >
                                            See what failed
                                        </a>
                                    ) : null}
                                </span>
                            </>
                        ) : status.phase === "building" ? (
                            <>
                                <Hammer className="size-4 text-muted-foreground" />
                                <span>
                                    {status.buildingCount ?? "New"} commit
                                    {status.buildingCount === 1 ? "" : "s"} still building. The update appears here once
                                    the image is published.
                                </span>
                            </>
                        ) : status.phase === "up-to-date" ? (
                            <>
                                <CheckCircle2 className="size-4 text-success" />
                                <span>Up to date.</span>
                            </>
                        ) : (
                            <>
                                <CircleDashed className="size-4 text-muted-foreground" />
                                <span className="text-muted-foreground">
                                    Update state unknown (this build carries no commit reference).
                                </span>
                            </>
                        )}
                    </div>

                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                        <Row label="Running build" value={status.current ?? "unknown"} />
                        <Row
                            label={status.source === "build" ? `Latest on ${deployment.branch}` : "Published build"}
                            value={status.latest ?? "-"}
                        />
                        <Row label="Updates from here" value={deployment.autoUpdate ? "allowed" : "blocked on this host"} />
                        <Row label="Last checked" value={formatChecked(status.checkedAt, format)} />
                    </dl>

                    <div className="flex flex-col gap-2 border-t border-border pt-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm">Update with</span>
                            <Select
                                aria-label="Where updates come from"
                                value={source}
                                onValueChange={(next) => void onSource(next as UpdateSource)}
                                options={SOURCE_CHOICES}
                                className="w-60"
                                disabled={updating}
                            />
                        </div>
                        <p className="text-xs text-muted-foreground">{sourceHint(source)}</p>
                    </div>

                    <div className="flex flex-col gap-2 border-t border-border pt-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm">Install updates</span>
                            <Select
                                aria-label="When updates install themselves"
                                value={policy.mode}
                                onValueChange={(mode) => void onSchedule({ ...policy, mode: mode as AutoUpdateMode })}
                                options={UPDATE_MODES}
                                className="w-60"
                                disabled={updating}
                            />
                            {policy.mode === "daily" ? (
                                <Input
                                    type="time"
                                    aria-label="Time of day updates install"
                                    className="w-32"
                                    value={timeDraft}
                                    disabled={updating}
                                    onChange={(event) => {
                                        const at = event.target.value;
                                        setTimeDraft(at);
                                        // Only a complete time is a schedule; the
                                        // half-typed states in between are not.
                                        if (TIME_OF_DAY.test(at)) void onSchedule({ ...policy, at });
                                    }}
                                />
                            ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground">{scheduleHint(policy)}</p>
                        {policyError ? <p className="text-xs text-danger">{policyError}</p> : null}
                    </div>

                    {available || updating || logText ? (
                        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                            {available ? (
                                <div className="flex items-center justify-between gap-2">
                                    <span>
                                        <a
                                            className="text-primary hover:underline"
                                            href={status.url}
                                            target="_blank"
                                            rel="noreferrer"
                                        >
                                            View changes
                                        </a>{" "}
                                        before installing, or update now - the dashboard stays up while it rolls over.
                                    </span>
                                    <Button size="sm" onClick={onUpdate} disabled={updating}>
                                        {updating ? (
                                            <RefreshCw className="size-4 animate-spin" />
                                        ) : (
                                            <DownloadCloud className="size-4" />
                                        )}
                                        {updating ? "Updating..." : "Update now"}
                                    </Button>
                                </div>
                            ) : null}
                            {updateMsg ? <p className="text-foreground">{updateMsg}</p> : null}
                            {showManual ? (
                                <p>
                                    Run <code className="text-foreground">polaris update</code> on the host to pull the
                                    latest images and redeploy.
                                </p>
                            ) : null}
                            {/* Rendered on the outcome as well as the text: a run cut
                                off before its first line of output has none, and
                                hiding the block would take the report button with it. */}
                            {updating || logText || logResult ? (
                                <LogViewer
                                    log={logText}
                                    name="polaris-update"
                                    className="h-64"
                                    emptyText={logResult ? "The updater wrote nothing." : "Waiting for the updater..."}
                                    header={
                                        <div className="flex items-center gap-2">
                                            <span className="font-medium text-foreground">Update log</span>
                                            {logResult ? (
                                                <span className={outcomeTone(logResult)}>{outcomeLabel(logResult)}</span>
                                            ) : null}
                                            {isFailure(logResult) ? (
                                                <Button size="sm" variant="secondary" onClick={onReport} disabled={reporting}>
                                                    <Bug className="size-3.5" />
                                                    {reporting ? "Preparing..." : "Report this failure"}
                                                </Button>
                                            ) : null}
                                        </div>
                                    }
                                />
                            ) : null}
                            {isFailure(logResult) ? (
                                <p>
                                    The report opens a prefilled issue with this log, your build, server type and
                                    domain. Nothing is sent until you submit it.
                                </p>
                            ) : null}
                        </div>
                    ) : null}
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Deployment</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1.5">
                        <span className="text-sm text-muted-foreground">Reachable at</span>
                        {deployment.addresses.length === 0 ? (
                            <p className="text-sm">No address is configured for this deployment.</p>
                        ) : (
                            deployment.addresses.map((address) => (
                                <div key={address.host} className="flex items-center gap-2 text-sm">
                                    <a
                                        className={`truncate font-medium hover:underline ${
                                            address.health.state === "down" ? "text-muted-foreground" : "text-primary"
                                        }`}
                                        href={address.url}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        {address.url}
                                    </a>
                                    <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                        {ADDRESS_KINDS[address.kind]}
                                    </span>
                                    {address.health.state === "down" ? (
                                        <span
                                            className="flex shrink-0 items-center gap-1 text-xs text-warning"
                                            title={downDetail(address.health, format)}
                                        >
                                            <TriangleAlert className="size-3" />
                                            not answering
                                        </span>
                                    ) : null}
                                    <CopyButton value={address.url} label={address.host} className="ml-auto" />
                                </div>
                            ))
                        )}
                    </div>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                        <Row label="Local hostname" value={`${deployment.hostname}.local`} />
                        <Row label="Repository" value={deployment.repo} />
                        <Row label="Release branch" value={deployment.branch} />
                    </dl>
                </CardBody>
            </Card>
        </div>
    );
}

function Row({ label, value }: { label: string; value: string; }) {
    return (
        <>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate font-medium">{value}</dd>
        </>
    );
}
