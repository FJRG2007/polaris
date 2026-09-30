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
 *
 * The page also asks on its own while it stays open, so a build published after it
 * was loaded is offered without anyone pressing anything. The button remains for the
 * case the automatic answer is not wanted: it forces past the shared cache.
 */

import type { SettingsOverview } from "./overview";
import { clearUpdateInProgress, markUpdateInProgress } from "@/lib/update-in-progress";
import { LogViewer } from "@/components/log-viewer";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import type { PublicUrls } from "@/lib/legal/service";
import { normalizeLegalContact } from "@polaris/core";
import { AddressList } from "@/components/address-list";
import type { UpdateStatus } from "@/lib/update-service";
import type { CheckedAddress } from "@/lib/address-health";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useRef, useState, useTransition } from "react";
import {
    isRecentRun,
    isUpdateInFlight,
    logIsFromRun,
    UPDATE_START_GRACE_MS,
    type UpdateLogTail
} from "@/lib/update-log";
import type { AutoUpdateMode, AutoUpdatePolicy, DisplayFormat, UpdateSource } from "@polaris/core";
import {
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Input,
    Select,
    Skeleton
} from "@polaris/ui";
import {
    Bug,
    CheckCircle2,
    CircleDashed,
    DownloadCloud,
    Hammer,
    RefreshCw,
    TriangleAlert
} from "lucide-react";
import {
    checkUpdatesAction,
    saveAutoUpdateAction,
    saveLegalContactAction,
    saveUpdateSourceAction,
    triggerHostUpdateAction,
    updateReportAction
} from "./actions";

/** The facts that come from the environment, which the server already has when
 *  it renders the page. Everything that has to be gone and asked for arrives
 *  later, in one request - see `SettingsOverview`. */
interface Deployment {
    readonly hostname: string;
    readonly repo: string;
    readonly branch: string;
    readonly autoUpdate: boolean;
}

type Translate = NamespaceTranslator<"admin">;

function sourceChoices(t: Translate): { value: UpdateSource; label: string }[] {
    return [
        { value: "image", label: t("settings.source.image") },
        { value: "build", label: t("settings.source.build") }
    ];
}

function sourceHint(source: UpdateSource, t: Translate): string {
    return source === "build" ? t("settings.source.buildHint") : t("settings.source.imageHint");
}

function formatChecked(iso: string, format: DisplayFormat, t: Translate): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? t("settings.updates.never") : format.dateTime(date);
}

// Last auto-check timestamp, module-level so the 30s throttle survives navigating
// away and back within the session.
let lastAutoCheck = 0;

/** Floor between two automatic checks, so returning to the tab a few times in a row
 *  does not re-ask on every one. */
const AUTO_CHECK_FLOOR_MS = 30_000;

/** How often the open page re-asks on its own. The answer is cached server-side for
 *  ten minutes and shared by every tab, so this costs a request rather than a GitHub
 *  call, and a build published while the page is open shows up without being asked
 *  for. */
const AUTO_CHECK_MS = 5 * 60_000;

/** How much of a finished run's log to show. Matches the endpoint's chunk cap, so
 *  the tail arrives in one read. */
const TAIL_BYTES = 128 * 1024;

/** The updater's completion marker, which is bookkeeping rather than output. */
const MARKER_RE = /^.*POLARIS_UPDATE_EXIT=-?\d+.*$\n?/gm;

function updateModes(t: Translate): { value: AutoUpdateMode; label: string }[] {
    return [
        { value: "off", label: t("settings.schedule.off") },
        { value: "immediate", label: t("settings.schedule.immediate") },
        { value: "daily", label: t("settings.schedule.daily") }
    ];
}

/** A complete 24-hour time. The time field reports "" until one is typed. */
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

function scheduleHint(policy: AutoUpdatePolicy, t: Translate): string {
    if (policy.mode === "immediate") return t("settings.schedule.immediateHint");
    if (policy.mode === "daily") return t("settings.schedule.dailyHint", { at: policy.at });
    return t("settings.schedule.offHint");
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

function outcomeLabel(result: UpdateResult, t: Translate): string {
    if (result.code === null) return t("settings.log.noResult");
    return result.code === 0 ? t("settings.log.success") : t("settings.log.failed", { code: result.code });
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
    initialPolicy,
    initialSource,
    initialContact,
    publicPages,
    deployment
}: {
    initialPolicy: AutoUpdatePolicy;
    initialSource: UpdateSource;
    initialContact: string;
    publicPages: PublicUrls;
    deployment: Deployment;
}) {
    const format = useDisplayFormat();
    const t = useTranslations("admin");
    // Null until the overview lands. The card draws its shape meanwhile rather
    // than a sentence about a check that has not happened - "Up to date" before
    // anybody has looked is the one thing this line must never say.
    const [status, setStatus] = useState<UpdateStatus | null>(null);
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
    // Live update log, streamed from the shared file the updater writes.
    const [logText, setLogText] = useState("");
    const [logResult, setLogResult] = useState<UpdateResult | null>(null);
    const [reporting, setReporting] = useState(false);
    // Followed rather than read once: removing an address changes the list, and the
    // page that did it must not keep offering the entry it has just taken away.
    const [addresses, setAddresses] = useState<CheckedAddress[] | null>(null);
    const [network, setNetwork] = useState<{
        publicIp: string | null;
        serverIp: string | null;
    } | null>(null);
    // The build that was serving when this run started. A different one answering
    // later means the new dashboard has taken over - the completion signal that
    // survives the updater being cut off by the restart it is performing.
    const startBuild = useRef<string | null>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const waitRef = useRef<ReturnType<typeof setInterval> | null>(null);
    // The host's clock when this browser last had an update accepted. Everything
    // written to the log before it belongs to the run before this one - see
    // `logIsFromRun`, which is the whole reason this is kept.
    const runFrom = useRef<number | null>(null);

    /**
     * Everything that had to be gone and asked for, once the page is on screen.
     *
     * One request for the three of them: they all land in the same render, and
     * three round trips would fill the update line, then the addresses, then the
     * IPs, each a frame apart. A failure leaves the skeletons standing rather
     * than replacing them with a wrong answer - the Check button is right there,
     * and it is the same question asked again.
     */
    useEffect(() => {
        const controller = new AbortController();
        void fetch("/api/admin/settings/overview", { signal: controller.signal })
            .then((answer) => (answer.ok ? (answer.json() as Promise<SettingsOverview>) : null))
            .then((overview) => {
                if (!overview) return;
                setStatus(overview.status);
                setAddresses(overview.addresses);
                setNetwork({ publicIp: overview.publicIp, serverIp: overview.serverIp });
            })
            .catch(() => undefined);
        return () => controller.abort();
    }, []);

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

    // Whether asking again right now would be pointless. Kept in a ref because the
    // timer below is installed once and would otherwise keep testing the values of
    // the render that installed it.
    const busy = useRef(false);
    useEffect(() => {
        busy.current = pending || updating;
    });

    /** Ask again, unless one has just been asked or an update is running. Unforced:
     *  the server holds one answer for every tab, so this costs a request rather than
     *  a call to GitHub. */
    function autoCheck(): void {
        if (busy.current || Date.now() - lastAutoCheck < AUTO_CHECK_FLOOR_MS) return;
        lastAutoCheck = Date.now();
        onCheck(false);
    }

    // Ask on arrival, on a timer while the page stays open, and when the tab is looked
    // at again - a machine that slept through several intervals is exactly the case
    // where the timer on its own comes back with an answer from before it slept.
    useEffect(() => {
        autoCheck();
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") autoCheck();
        }, AUTO_CHECK_MS);
        const onVisible = (): void => {
            if (document.visibilityState === "visible") autoCheck();
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
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
                // An update this browser started whose log has not appeared yet.
                // The updater is pulled before it runs, so what is on disk is
                // still the previous run, finished and successful - and reading
                // that as this run's result is what left the card idle and asked
                // for the button a second time.
                const started = rememberedRunStart();
                if (started !== null && !logIsFromRun(data, started)) {
                    if (data.now - started <= UPDATE_START_GRACE_MS) {
                        runFrom.current = started;
                        setUpdating(true);
                        setUpdateMsg(t("settings.run.starting"));
                        pollLogs();
                        waitForUpdate();
                        return;
                    }
                    // Long enough that nothing is coming. Stop speaking for it.
                    forgetRunStart();
                }
                if (isUpdateInFlight(data, data.now)) {
                    runFrom.current = started;
                    setUpdating(true);
                    setUpdateMsg(t("settings.run.reattached"));
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

    /** Where the moment an update was accepted is parked, for this tab. */
    const RUN_START_KEY = "polaris.update.startedAt";

    /**
     * When this browser had an update accepted, parked where the reload the
     * update itself causes cannot take it.
     *
     * Per tab on purpose: two tabs watching the same update are two independent
     * watchers, and one of them finishing is no reason for the other to stop.
     * Every access is guarded - a private window or blocked site data throws on
     * the way in as well as the way out, and losing this only costs the page its
     * ability to tell an old log from a new one.
     */
    function rememberRunStart(at: number): void {
        try {
            sessionStorage.setItem(RUN_START_KEY, String(at));
            // Every tab on this device: while the new build takes over, the
            // connection banner says "updating" rather than "can't reach Polaris".
            markUpdateInProgress();
        } catch {
            // Nothing to do about it, and nothing that stops the update.
        }
    }

    function forgetRunStart(): void {
        try {
            sessionStorage.removeItem(RUN_START_KEY);
            clearUpdateInProgress();
        } catch {
            // As above.
        }
    }

    function rememberedRunStart(): number | null {
        try {
            const raw = sessionStorage.getItem(RUN_START_KEY);
            const at = raw === null ? Number.NaN : Number(raw);
            return Number.isFinite(at) ? at : null;
        } catch {
            return null;
        }
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
                ? t("settings.run.finishedAt", { at })
                : first.exitCode === null
                  ? t("settings.run.neverReported", { at })
                  : t("settings.run.lastFailed", { code: first.exitCode })
        );
    }

    /**
     * Open the prefilled issue. The tab is claimed before the await, because a
     * window opened after one is a popup as far as the browser is concerned - and
     * the report would be silently blocked on the click that asked for it.
     */
    /**
     * Open the failure as an issue, in a tab of its own.
     *
     * The tab is opened on the press and pointed at the report afterwards,
     * because the address is built on the server and a tab opened after that
     * round trip is a popup the browser blocks.
     *
     * Opened WITHOUT `noopener`, which is the correction: with it the browser
     * hands back null rather than a handle, so the blank tab was left sitting on
     * about:blank and the report loaded over the settings screen instead. The
     * link is severed by hand the moment the tab has somewhere to go, which buys
     * the same thing `noopener` does and still leaves something to point.
     */
    async function onReport() {
        setReporting(true);
        const tab = window.open("about:blank", "_blank");
        try {
            const { url } = await updateReportAction();
            if (tab) {
                tab.opener = null;
                tab.location.replace(url);
            } else {
                // The popup was blocked, and there is nothing else to do with a
                // report somebody asked for.
                window.location.href = url;
            }
        } catch {
            tab?.close();
            setUpdateMsg(t("settings.run.reportFailed"));
        } finally {
            setReporting(false);
        }
    }

    async function onUpdate() {
        setUpdating(true);
        setUpdateMsg(null);
        setLogText("");
        setLogResult(null);
        // The host's clock before anything is asked for, so what the previous run
        // left on disk can be told from what this one writes. Read from the host
        // rather than taken from here: the two clocks disagree, and this decides
        // whether a finished log is this run's result or the last one's.
        const before = await fetchTail(0);
        runFrom.current = before ? Math.max(before.now, before.updatedAt) : null;
        const { status: result } = await triggerHostUpdateAction();
        if (result === "started") {
            if (runFrom.current !== null) rememberRunStart(runFrom.current);
            setUpdateMsg(t("settings.run.started"));
            pollLogs();
            // Watch health as well: an older updater restarts the dashboard in place
            // instead of rolling it over, and that restart is then the only signal.
            waitForUpdate();
            return; // stay in the updating state; completion reloads the page
        }
        setUpdating(false);
        // Each says what this machine needs in order to update, in the reader's
        // terms - never a command to type on it.
        if (result === "unavailable") setUpdateMsg(t("settings.run.unavailable"));
        else if (result === "disabled") setUpdateMsg(t("settings.run.disabled"));
        else setUpdateMsg(t("settings.run.unreachable"));
    }

    // Fallback completion watcher, for an update that restarts the dashboard rather
    // than rolling it over: once it has gone down and come back, reload. Idempotent -
    // only one health watcher runs at a time.
    function waitForUpdate(): void {
        if (waitRef.current) return;
        let sawDown = false;
        let failures = 0;
        let tries = 0;
        waitRef.current = setInterval(async () => {
            tries += 1;
            try {
                const res = await fetch("/api/health", { cache: "no-store" });
                if (res.ok) {
                    failures = 0;
                    if (sawDown) finish(t("settings.run.updated"));
                } else {
                    failures += 1;
                }
            } catch {
                failures += 1;
            }
            // Two in a row before this counts as the dashboard going down. One
            // failed probe is a dropped request or a moment of edge trouble, and
            // treating it as the restart meant the next success reloaded the page
            // on an update that had not even begun.
            if (failures >= 2) sawDown = true;
            if (tries >= 300) {
                stopPolling();
                setUpdating(false);
                setUpdateMsg(t("settings.run.slow"));
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
        // The run is over, so the page that comes back after this reload has no
        // run of its own to wait for.
        forgetRunStart();
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
                        setUpdateMsg(t("settings.run.noLiveLog"));
                        waitForUpdate();
                    }
                    return;
                }
                // Still the log the previous run left: the updater is an image
                // that gets pulled before it writes anything, and until it does
                // the last line on disk is the last run's exit marker. Reading
                // that as this run's result is what reloaded the page seconds
                // after the button was pressed and then offered the update again.
                //
                // The build check still stands, because a rollover that finished
                // this fast is a real completion whatever the log says.
                if (!logIsFromRun(data, runFrom.current)) {
                    if (data.build && startBuild.current && data.build !== startBuild.current) {
                        setLogResult({ code: 0 });
                        finish(t("settings.run.serving"));
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
                    finish(t("settings.run.serving"));
                    return;
                }
                if (!startBuild.current) startBuild.current = data.build;
                if (data.done) {
                    stopPolling();
                    setLogResult({ code: data.exitCode });
                    if (data.exitCode === 0) {
                        finish(t("settings.run.complete"));
                    } else {
                        setUpdating(false);
                        setUpdateMsg(
                            data.exitCode === null
                                ? t("settings.run.failedUnknown")
                                : t("settings.run.failed", { code: data.exitCode })
                        );
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
    const available = status?.phase === "available";

    return (
        <div className="flex w-full flex-col gap-4">
            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                        <CardTitle>{t("settings.updates.title")}</CardTitle>
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => onCheck()}
                            disabled={pending || updating}
                        >
                            <RefreshCw className={`size-4 ${pending ? "animate-spin" : ""}`} />
                            {pending ? t("settings.updates.checking") : t("settings.updates.check")}
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
                                <span>{step ? t("settings.updates.updatingStep", { step }) : t("settings.updates.updating")}</span>
                            </>
                        ) : !status ? (
                            <Skeleton className="h-4 w-56" />
                        ) : status.error ? (
                            <>
                                <TriangleAlert className="size-4 text-warning" />
                                <span className="text-warning">{status.error}</span>
                            </>
                        ) : available ? (
                            <>
                                <DownloadCloud className="size-4 text-primary" />
                                <span>
                                    {typeof status.behindBy === "number" && status.behindBy > 0
                                        ? t("settings.updates.availableBehind", {
                                              count: status.behindBy,
                                              shown: String(status.behindBy),
                                              branch: deployment.branch
                                          })
                                        : t("settings.updates.available")}
                                </span>
                            </>
                        ) : status.phase === "blocked" ? (
                            <>
                                <TriangleAlert className="size-4 text-warning" />
                                <span>
                                    {status.checksUrl
                                        ? t.rich("settings.updates.blockedWithLink", {
                                              link: (chunks) => (
                                                  <a
                                                      key="link"
                                                      className="text-primary hover:underline"
                                                      href={status.checksUrl ?? undefined}
                                                      target="_blank"
                                                      rel="noreferrer"
                                                  >
                                                      {chunks}
                                                  </a>
                                              )
                                          })
                                        : t("settings.updates.blocked")}
                                </span>
                            </>
                        ) : status.phase === "building" ? (
                            <>
                                <Hammer className="size-4 text-muted-foreground" />
                                <span>
                                    {typeof status.buildingCount === "number"
                                        ? t("settings.updates.building", {
                                              count: status.buildingCount,
                                              shown: String(status.buildingCount)
                                          })
                                        : t("settings.updates.buildingNew")}
                                </span>
                            </>
                        ) : status.phase === "up-to-date" ? (
                            <>
                                <CheckCircle2 className="size-4 text-success" />
                                <span>{t("settings.updates.upToDate")}</span>
                            </>
                        ) : (
                            <>
                                <CircleDashed className="size-4 text-muted-foreground" />
                                <span className="text-muted-foreground">
                                    {t("settings.updates.unknown")}
                                </span>
                            </>
                        )}
                    </div>

                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                        <Row label={t("settings.updates.runningBuild")} value={status?.current ?? null} />
                        <Row
                            label={
                                status?.source === "build"
                                    ? t("settings.updates.latestOn", { branch: deployment.branch })
                                    : t("settings.updates.publishedBuild")
                            }
                            value={status ? (status.latest ?? "-") : null}
                        />
                        <Row
                            label={t("settings.updates.fromHere")}
                            value={
                                deployment.autoUpdate
                                    ? t("settings.updates.allowed")
                                    : t("settings.updates.blockedHere")
                            }
                        />
                        <Row
                            label={t("settings.updates.lastChecked")}
                            value={status ? formatChecked(status.checkedAt, format, t) : null}
                        />
                    </dl>

                    <div className="flex flex-col gap-2 border-t border-border pt-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm">{t("settings.source.label")}</span>
                            <Select
                                aria-label={t("settings.source.ariaLabel")}
                                value={source}
                                onValueChange={(next) => void onSource(next as UpdateSource)}
                                options={sourceChoices(t)}
                                className="w-60"
                                disabled={updating}
                            />
                        </div>
                        <p className="text-xs text-muted-foreground">{sourceHint(source, t)}</p>
                    </div>

                    <div className="flex flex-col gap-2 border-t border-border pt-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm">{t("settings.schedule.label")}</span>
                            <Select
                                aria-label={t("settings.schedule.ariaLabel")}
                                value={policy.mode}
                                onValueChange={(mode) =>
                                    void onSchedule({ ...policy, mode: mode as AutoUpdateMode })
                                }
                                options={updateModes(t)}
                                className="w-60"
                                disabled={updating}
                            />
                            {policy.mode === "daily" ? (
                                <Input
                                    type="time"
                                    aria-label={t("settings.schedule.timeLabel")}
                                    className="w-32"
                                    value={timeDraft}
                                    disabled={updating}
                                    onChange={(event) => {
                                        const at = event.target.value;
                                        setTimeDraft(at);
                                        // Only a complete time is a schedule; the
                                        // half-typed states in between are not.
                                        if (TIME_OF_DAY.test(at))
                                            void onSchedule({ ...policy, at });
                                    }}
                                />
                            ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground">{scheduleHint(policy, t)}</p>
                        {policyError ? <p className="text-xs text-danger">{policyError}</p> : null}
                    </div>

                    {available || updating || logText ? (
                        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                            {available ? (
                                <div className="flex items-center justify-between gap-2">
                                    <span>
                                        {t.rich("settings.updates.viewChanges", {
                                            link: (chunks) => (
                                                <a
                                                    key="link"
                                                    className="text-primary hover:underline"
                                                    href={status.url}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                >
                                                    {chunks}
                                                </a>
                                            )
                                        })}
                                    </span>
                                    <Button size="sm" onClick={onUpdate} disabled={updating}>
                                        {updating ? (
                                            <RefreshCw className="size-4 animate-spin" />
                                        ) : (
                                            <DownloadCloud className="size-4" />
                                        )}
                                        {updating ? t("settings.updates.updating") : t("settings.updates.updateNow")}
                                    </Button>
                                </div>
                            ) : null}
                            {updateMsg ? <p className="text-foreground">{updateMsg}</p> : null}
                            {/* Rendered on the outcome as well as the text: a run cut
                                off before its first line of output has none, and
                                hiding the block would take the report button with it. */}
                            {updating || logText || logResult ? (
                                <LogViewer
                                    log={logText}
                                    name="polaris-update"
                                    className="h-64"
                                    emptyText={
                                        logResult
                                            ? t("settings.log.empty")
                                            : t("settings.log.waiting")
                                    }
                                    header={
                                        <div className="flex items-center gap-2">
                                            <span className="font-medium text-foreground">
                                                {t("settings.log.title")}
                                            </span>
                                            {logResult ? (
                                                <span className={outcomeTone(logResult)}>
                                                    {outcomeLabel(logResult, t)}
                                                </span>
                                            ) : null}
                                            {isFailure(logResult) ? (
                                                <Button
                                                    size="sm"
                                                    variant="secondary"
                                                    onClick={onReport}
                                                    disabled={reporting}
                                                >
                                                    <Bug className="size-3.5" />
                                                    {reporting
                                                        ? t("settings.log.preparing")
                                                        : t("settings.log.report")}
                                                </Button>
                                            ) : null}
                                        </div>
                                    }
                                />
                            ) : null}
                            {isFailure(logResult) ? (
                                <p>{t("settings.log.reportNote")}</p>
                            ) : null}
                        </div>
                    ) : null}
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("settings.deployment.title")}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1.5">
                        <span className="text-sm text-muted-foreground">{t("settings.deployment.reachableAt")}</span>
                        {addresses ? (
                            <AddressList
                                addresses={addresses}
                                onChanged={setAddresses}
                                manageHref="/admin/domains"
                            />
                        ) : (
                            // Shaped like the rows it will become: a list of
                            // addresses, each with its verdict beside it.
                            <div className="flex flex-col gap-1.5">
                                <Skeleton className="h-8 w-full" />
                                <Skeleton className="h-8 w-4/5" />
                            </div>
                        )}
                    </div>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                        <Row label={t("settings.deployment.localHostname")} value={`${deployment.hostname}.local`} />
                        <Row
                            label={t("settings.deployment.serverIp")}
                            value={network ? (network.serverIp ?? t("settings.deployment.unknown")) : null}
                        />
                        <Row
                            label={t("settings.deployment.publicIp")}
                            value={network ? (network.publicIp ?? t("settings.deployment.notDetected")) : null}
                        />
                        <Row
                            label={t("settings.deployment.repository")}
                            value={deployment.repo}
                            href={`https://github.com/${deployment.repo}`}
                        />
                        <Row label={t("settings.deployment.branch")} value={deployment.branch} />
                    </dl>
                </CardBody>
            </Card>

            <PublicPagesCard initialContact={initialContact} pages={publicPages} />
        </div>
    );
}

/**
 * The three pages that exist outside the login, and the one line on them this
 * deployment gets to write.
 *
 * Here rather than buried in the Integrations screen because they are not about
 * one provider: Google's verification reads all three, Epic's brand review reads
 * two, and an operator who has just been refused by either needs to find them by
 * name. The URLs are shown ready to copy for exactly that - they are what those
 * forms ask for, and typing them from memory is how a review fails on a
 * mistyped path.
 */
function PublicPagesCard({ initialContact, pages }: { initialContact: string; pages: PublicUrls }) {
    const [contact, setContact] = useState(initialContact);
    const [saved, setSaved] = useState(initialContact);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const t = useTranslations("admin");
    const tc = useTranslations("common");

    // Nothing to save when it comes back to what is stored: a value edited and
    // put back is not a change.
    const dirty = normalizeLegalContact(contact) !== saved;

    function onSave() {
        const next = normalizeLegalContact(contact);
        setError(null);
        startTransition(async () => {
            const result = await saveLegalContactAction(next);
            if (result.error) {
                setError(result.error);
                return;
            }
            setSaved(result.contact ?? "");
            setContact(result.contact ?? "");
        });
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("settings.publicPages.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">{t("settings.publicPages.intro")}</p>

                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                    <Row label={t("settings.publicPages.home")} value={pages.home} href={pages.home} />
                    <Row label={t("settings.publicPages.privacy")} value={pages.privacy} href={pages.privacy} />
                    <Row label={t("settings.publicPages.terms")} value={pages.terms} href={pages.terms} />
                </dl>

                <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">{t("settings.publicPages.contact")}</span>
                    <div className="flex items-center gap-2">
                        <Input
                            value={contact}
                            onChange={(event) => setContact(event.target.value)}
                            placeholder="you@example.com"
                            autoComplete="off"
                            aria-label={t("settings.publicPages.contactLabel")}
                        />
                        <Button size="sm" onClick={onSave} disabled={pending || !dirty}>
                            {pending ? tc("actions.saving") : tc("actions.save")}
                        </Button>
                    </div>
                    <span className="text-xs text-muted-foreground">
                        {t("settings.publicPages.contactHint")}
                    </span>
                    {error ? <span className="text-xs text-danger">{error}</span> : null}
                </label>
            </CardBody>
        </Card>
    );
}

/** One fact. A null value is one that has not arrived yet - the label is already
 *  right, so it stays and only the answer is a placeholder. */
function Row({ label, value, href }: { label: string; value: string | null; href?: string }) {
    return (
        <>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate font-medium">
                {value === null ? (
                    <Skeleton className="h-4 w-24" />
                ) : href ? (
                    <a
                        className="text-primary hover:underline"
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                    >
                        {value}
                    </a>
                ) : (
                    value
                )}
            </dd>
        </>
    );
}
