"use client";

/**
 * Updates client view: the Polaris update card.
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

import { SecurityUpdates } from "./security-updates";
import { UpdateChangelog } from "./update-changelog";
import { FactRow as Row } from "../settings/fact-row";
import { useSettingsOverview } from "../settings/use-overview";
import * as shared from "@/lib/update-status-shared";
import { checkForNewBuild } from "@/lib/new-build";
import { useHeldCall } from "@/app/(app)/chat/call-hold";
import { clearUpdateInProgress, markUpdateInProgress } from "@/lib/update-in-progress";
import { LogViewer } from "@/components/log-viewer";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useRef, useState, useTransition } from "react";
import * as polls from "./update-polls";
import * as adminPolls from "../admin-polls";
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
    Select,
    Skeleton,
    DateInput
} from "@polaris/ui";
import {
    Bug,
    CheckCircle2,
    CircleDashed,
    DownloadCloud,
    Hammer,
    RefreshCw,
    ShieldAlert,
    TriangleAlert
} from "lucide-react";
import {
    ownVulnerabilitiesAction,
    saveAutoUpdateAction,
    saveUpdateSourceAction,
    triggerHostUpdateAction,
    updateReportAction
} from "./actions";
import { UpdateProgress, type WatchedRun } from "./update-progress";

/** The facts that come from the environment, which the server already has when
 *  it renders the page. Everything that has to be gone and asked for arrives
 *  later, in one request - see `SettingsOverview`. */
interface Deployment {
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

/** The one part of the overview this card draws. */
const UPDATE_PARTS = ["status"] as const;

/** How often the open page re-asks on its own. The answer is cached server-side for
 *  ten minutes and shared by every tab, so this costs a request rather than a GitHub
 *  call, and a build published while the page is open shows up without being asked
 *  for. */
const AUTO_CHECK_MS = 5 * 60_000;

/** How many answers in a row the new build has to give before the page reloads
 *  onto it. While a rollover overlaps, the edge sends each request to either
 *  container, so the first answer from the new build says nothing about the next
 *  one - and a reload into that overlap fetches the page from one container and
 *  its scripts from the other, which 404 there and leave the page unhydrated:
 *  every value a skeleton until somebody reloads by hand. */
const SETTLED_ANSWERS = 3;

/** How much of a finished run's log to show. Matches the endpoint's chunk cap, so
 *  the tail arrives in one read. */
const TAIL_BYTES = 128 * 1024;

/** The updater's completion marker, which is bookkeeping rather than output. */
const MARKER_RE = /^.*POLARIS_UPDATE_EXIT=-?\d+.*$\n?/gm;

/** "HH:00" for the quiet hour. */
function hourText(hour: number): string {
    return `${String(hour).padStart(2, "0")}:00`;
}

/** The quiet hour needs this host to install on its own; without that it is
 *  shown, disabled, so the reason sits under it. */
function updateModes(
    t: Translate,
    quietHour: number,
    canInstall: boolean
): { value: AutoUpdateMode; label: string; disabled?: boolean }[] {
    return [
        {
            value: "quiet",
            label: t("settings.schedule.quiet", { at: hourText(quietHour) }),
            disabled: !canInstall
        },
        { value: "immediate", label: t("settings.schedule.immediate") },
        { value: "daily", label: t("settings.schedule.daily") },
        { value: "off", label: t("settings.schedule.off") }
    ];
}

/** A complete 24-hour time. The time field reports "" until one is typed. */
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

function scheduleHint(
    policy: AutoUpdatePolicy,
    t: Translate,
    quietHour: number,
    canInstall: boolean
): string {
    if (policy.mode === "quiet") return t("settings.schedule.quietHint", { at: hourText(quietHour) });
    if (!canInstall) return t("settings.schedule.quietUnavailable");
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
    return result.code === 0
        ? t("settings.log.success")
        : t("settings.log.failed", { code: result.code });
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

export function UpdatesView({
    initialPolicy,
    initialSource,
    quietHour,
    canInstall,
    deployment
}: {
    initialPolicy: AutoUpdatePolicy;
    initialSource: UpdateSource;
    /** The hour (0-23, server time) this deployment is least used. */
    quietHour: number;
    /** Whether this host can install an update on its own. */
    canInstall: boolean;
    deployment: Deployment;
}) {
    const format = useDisplayFormat();
    const t = useTranslations("admin");
    // Read when the update finishes, which is a callback long after this render.
    const held = useHeldCall();
    const inCall = useRef(false);
    inCall.current = Boolean(held?.session);
    // Null until the overview lands. The card draws its shape meanwhile rather
    // than a sentence about a check that has not happened - "Up to date" before
    // anybody has looked is the one thing this line must never say.
    const { status, setStatus } = useSettingsOverview(UPDATE_PARTS);
    // The badge in the top bar asks on its own; a newer answer it heard shows
    // here too, so it never offers an update this card does not know about.
    useEffect(
        () =>
            shared.onUpdateStatus((next) =>
                setStatus((current) =>
                    current && Date.parse(current.checkedAt) > Date.parse(next.checkedAt)
                        ? current
                        : next
                )
            ),
        [setStatus]
    );
    // Whatever drew the card - the overview or a check - an answer the server
    // gave from a cache it is refreshing right now is asked again shortly for
    // the fresh one, rather than standing for five minutes.
    const staleAnswer = status !== null && shared.isStale(status) ? status.checkedAt : null;
    useEffect(() => {
        if (!staleAnswer) return;
        const timer = setTimeout(() => {
            if (!busy.current) onCheck(false);
        }, shared.STALE_RETRY_MS);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [staleAnswer]);
    const [checkFailed, setCheckFailed] = useState(false);
    // The quiet hour is the default, and a host that cannot install on its own
    // acts on it as "only tell me" - so that is what the control says there.
    const [policy, setPolicy] = useState<AutoUpdatePolicy>(
        initialPolicy.mode === "quiet" && !canInstall ? { ...initialPolicy, mode: "off" } : initialPolicy
    );
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
    // The run's timing as the server last reported it, and a clock that moves the
    // bar between polls.
    const [run, setRun] = useState<WatchedRun | null>(null);
    const [clock, setClock] = useState(() => Date.now());
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

    function onCheck(force = true) {
        startTransition(async () => {
            // A check that cannot reach the server (a restart under way, a tab
            // left on the previous build) keeps what is on screen, and asks
            // whether Polaris was updated under this tab so the update notice
            // and its reload can take over.
            setCheckFailed(false);
            const answer = await polls.updateStatus(force).catch(async () => {
                if (!(await checkForNewBuild()) && force) setCheckFailed(true);
                return null;
            });
            if (!answer) return;
            shared.noteUpdateStatus(answer);
            setStatus(answer);
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
        setStatus(null);
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
        const tail = (await res.json()) as UpdateLogTail;
        // Kept when an answer has none: the run is closed by the build that
        // landed it, and the page is about to reload onto that build anyway.
        if (tail.run) setRun({ ...tail.run, skew: Date.now() - tail.now });
        return tail;
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
        setRun(null);
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

    /**
     * Stop everything and reload, so the page comes back on the new build.
     *
     * Not while a call is on in this page. Reloading here left the call, and in
     * the desktop app a reload that lands while the edge is still switching
     * builds goes through its error screen, which is a navigation the call is
     * never walked back from - so the person was out of the call without being
     * told. The update notice takes over instead: it offers the reload and
     * carries the call through it (`call-resume`).
     */
    function finish(message: string): void {
        stopPolling();
        // The run is over, so the page that comes back after this reload has no
        // run of its own to wait for.
        forgetRunStart();
        if (inCall.current) {
            setUpdateMsg(t("settings.run.doneInCall"));
            void checkForNewBuild();
            return;
        }
        setUpdateMsg(message);
        setTimeout(() => window.location.reload(), 1200);
    }

    // Tail the shared update log by byte offset, so progress streams live and the
    // poll simply resumes if the dashboard is recreated mid-update.
    function pollLogs(): void {
        let offset = 0;
        let missing = 0;
        let sawContent = false;
        let newAnswers = 0;
        // Whether this answer is the new build, and whether it has now been the
        // only one answering for long enough to reload onto - see SETTLED_ANSWERS.
        const settledOnNewBuild = (build: string | null): boolean => {
            if (!build || !startBuild.current) return false;
            newAnswers = build === startBuild.current ? 0 : newAnswers + 1;
            return newAnswers >= SETTLED_ANSWERS;
        };
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
                    if (settledOnNewBuild(data.build)) {
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
                // The new build answering, and only it, means the new dashboard is
                // serving. True whether it took over by rollover or by restart, and
                // true even if the updater never got to write its marker.
                if (settledOnNewBuild(data.build)) {
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

    const timed = updating && run !== null;
    useEffect(() => {
        if (!timed) return;
        const tick = setInterval(() => setClock(Date.now()), 1000);
        return () => clearInterval(tick);
    }, [timed]);

    const step = updating ? currentStep(logText) : null;
    const available = status?.phase === "available";

    return (
        <div className="flex w-full flex-col gap-4">
            <Card>
                <CardHeader>
                    <div className="flex flex-wrap items-center justify-between gap-2">
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
                                <span>
                                    {step
                                        ? t("settings.updates.updatingStep", { step })
                                        : t("settings.updates.updating")}
                                </span>
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
                    {timed && run ? <UpdateProgress run={run} now={clock} /> : null}
                    {checkFailed ? (
                        <p className="text-xs text-danger">{t("settings.updates.checkFailed")}</p>
                    ) : null}

                    <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-x-8">
                        <Row
                            label={t("settings.updates.runningBuild")}
                            value={status?.current ?? null}
                        />
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
                                className="w-60 max-w-full"
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
                                options={updateModes(t, quietHour, canInstall)}
                                className="w-60 max-w-full"
                                disabled={updating}
                            />
                            {policy.mode === "daily" ? (
                                <DateInput
                                    mode="time"
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
                        <p className="text-xs text-muted-foreground">{scheduleHint(policy, t, quietHour, canInstall)}</p>
                        {policyError ? <p className="text-xs text-danger">{policyError}</p> : null}
                    </div>

                    <SecurityUpdates disabled={updating} />

                    <OwnVulnerabilitiesLine available={available} />

                    {available && status?.latest ? <UpdateChangelog head={status.latest} /> : null}

                    {available || updating || logText ? (
                        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                            {available ? (
                                <div className="flex flex-wrap items-center justify-between gap-2">
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
                                        {updating
                                            ? t("settings.updates.updating")
                                            : t("settings.updates.updateNow")}
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
                            {isFailure(logResult) ? <p>{t("settings.log.reportNote")}</p> : null}
                        </div>
                    ) : null}
                </CardBody>
            </Card>
        </div>
    );
}

/**
 * What the last scans found in Polaris's own images, beside the Update control.
 * Only what a scan reported: with no scan of them there is no line at all.
 */
function OwnVulnerabilitiesLine({ available }: { available: boolean }) {
    const t = useTranslations("admin");
    const [found, setFound] = useState<Awaited<ReturnType<typeof ownVulnerabilitiesAction>>>(null);
    useEffect(() => {
        let live = true;
        void adminPolls
            .ownVulnerabilities()
            .then((result) => live && setFound(result))
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, []);
    if (!found) return null;
    const serious = found.critical + found.high > 0;
    // An image whose newest scan failed is named as not scanned, never counted
    // with what an older image under its name had.
    const failed = found.failed ?? 0;
    return (
        <div className="flex items-start gap-2 text-sm">
            <ShieldAlert
                className={`mt-0.5 size-4 shrink-0 ${serious ? "text-danger" : failed > 0 ? "text-warning" : "text-muted-foreground"}`}
                aria-hidden
            />
            <p className="min-w-0">
                {found.images === 0
                    ? null
                    : serious
                      ? t("settings.updates.ownVulns", {
                            critical: found.critical,
                            high: found.high,
                            images: found.images
                        }) + " "
                      : t("settings.updates.ownVulnsNone", { images: found.images }) + " "}
                {failed > 0 ? t("settings.updates.ownVulnsFailed", { failed }) + " " : null}
                {serious && available ? t("settings.updates.ownVulnsUpdate") + " " : null}
                <a className="text-primary hover:underline" href="/admin/security/scans">
                    {t("settings.updates.ownVulnsLink")}
                </a>
            </p>
        </div>
    );
}
