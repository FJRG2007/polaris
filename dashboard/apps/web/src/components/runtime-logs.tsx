"use client";

/**
 * What running services print, in two modes over one viewer.
 *
 * Live follows every container of the services on screen as they write, pushed
 * over one connection rather than polled, and pauses without losing its place:
 * resuming reopens the follow and the lines already shown are not shown twice.
 * History reads what Polaris kept - a week of it, a page at a time - searched by
 * phrase and time range, and loads older lines as the reader scrolls up.
 *
 * Both render through the shared log viewer, so a service's own tab and the
 * project's Logs screen read the same.
 */

import { zonedInstant } from "@polaris/core";
import { LogViewer } from "@/components/log-viewer";
import { useDisplayFormat } from "@/components/display-format";
import { Button, Input, SegmentedControl, cn } from "@polaris/ui";
import { Loader2, Pause, Play, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatStreamLog, mergeStreamLines, type StreamLine } from "@/lib/deploy/log-stream";

type Mode = "live" | "history";

/** Lines read back from the tail when a follow opens. */
const LIVE_TAIL = 300;

/** The longest wait before opening a follow again once its output stopped. */
const MAX_RETRY_MS = 60_000;

/** Lines per history page, and the most one view holds. */
const HISTORY_PAGE = 200;
const HISTORY_CAP = 3000;

type LiveStatus = "connecting" | "live" | "paused" | "ended" | "failed";

/**
 * Follow the services' output until unmounted or paused.
 *
 * When every container's output has stopped - a deploy replaced it, the service
 * was stopped - the follow is opened again after a wait that doubles each time
 * nothing new arrives, so a service that was redeployed is followed again within
 * seconds and one that stays stopped is not asked about every few.
 */
export function useRuntimeLogStream(serviceIds: readonly string[], enabled = true) {
    const key = serviceIds.join(",");
    const [lines, setLines] = useState<StreamLine[]>([]);
    const [containers, setContainers] = useState<Record<string, string[]>>({});
    const [stopped, setStopped] = useState<Record<string, string>>({});
    const [status, setStatus] = useState<LiveStatus>("connecting");
    const [paused, setPaused] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const seen = useRef(new Map<string, string>());
    const retryMs = useRef(5000);

    // Another set of services is another log.
    useEffect(() => {
        seen.current = new Map();
        retryMs.current = 5000;
        setLines([]);
        setContainers({});
        setStopped({});
    }, [key]);

    useEffect(() => {
        if (!enabled || !key) return;
        if (paused) {
            setStatus("paused");
            return;
        }
        setStatus("connecting");
        const source = new EventSource(`/api/deploy/logs/stream?services=${encodeURIComponent(key)}&tail=${LIVE_TAIL}`);
        let retry: ReturnType<typeof setTimeout> | null = null;

        source.addEventListener("open", () => setStatus("live"));
        source.addEventListener("following", (event) => {
            const data = readEvent<{ serviceId: string; containers: string[] }>(event);
            if (data) setContainers((current) => ({ ...current, [data.serviceId]: data.containers }));
        });
        source.addEventListener("lines", (event) => {
            const batch = readEvent<StreamLine[]>(event);
            if (!batch || batch.length === 0) return;
            retryMs.current = 5000;
            setLines((current) => mergeStreamLines(current, batch, seen.current));
        });
        source.addEventListener("ended", (event) => {
            const data = readEvent<{ serviceId: string; container: string; reason: string | null }>(event);
            if (data?.reason) setStopped((current) => ({ ...current, [`${data.serviceId}/${data.container}`]: data.reason as string }));
        });
        source.addEventListener("done", () => {
            source.close();
            setStatus("ended");
            retry = setTimeout(() => setAttempt((value) => value + 1), retryMs.current);
            retryMs.current = Math.min(retryMs.current * 2, MAX_RETRY_MS);
        });
        source.onerror = () => {
            // Closed is a refusal (signed out, no access); anything else is the
            // browser already reconnecting on its own.
            setStatus(source.readyState === EventSource.CLOSED ? "failed" : "connecting");
        };
        return () => {
            source.close();
            if (retry) clearTimeout(retry);
        };
    }, [key, enabled, paused, attempt]);

    const containerCount = Object.values(containers).reduce((total, list) => total + list.length, 0);
    return { lines, status, paused, setPaused, containerCount, stopped };
}

function readEvent<T>(event: Event): T | null {
    try {
        return JSON.parse((event as MessageEvent<string>).data) as T;
    } catch {
        return null;
    }
}

/** Live and History over the same services, switched in place. */
export function RuntimeLogs({
    serviceIds,
    historyIds = serviceIds,
    name,
    className,
    followNote
}: {
    /** Followed live. */
    serviceIds: readonly string[];
    /** Searched in History, when that is a different set - what was kept outlives
     *  a stopped service, which live has nothing to follow on. */
    historyIds?: readonly string[];
    /** Names an exported file. */
    name: string;
    className?: string;
    /** Said beside the controls, for a caller that followed fewer than it lists. */
    followNote?: string;
}) {
    const [mode, setMode] = useState<Mode>("live");
    const toggle = (
        <SegmentedControl
            size="sm"
            value={mode}
            onValueChange={setMode}
            options={[
                { value: "live", label: "Live" },
                { value: "history", label: "History", title: "What was kept over the last week" }
            ]}
            aria-label="Log mode"
            className="shrink-0"
        />
    );
    return mode === "live" ? (
        <LiveLog serviceIds={serviceIds} name={name} className={className} lead={toggle} note={followNote} />
    ) : (
        <HistoryLog serviceIds={historyIds} name={name} className={className} lead={toggle} />
    );
}

function LiveLog({
    serviceIds,
    name,
    className,
    lead,
    note
}: {
    serviceIds: readonly string[];
    name: string;
    className?: string;
    lead: ReactNode;
    note?: string;
}) {
    const stream = useRuntimeLogStream(serviceIds);
    const labelled = useMemo(() => new Set(stream.lines.map((line) => `${line.serviceId}/${line.container}`)).size > 1, [stream.lines]);
    const log = useMemo(() => formatStreamLog(stream.lines, labelled), [stream.lines, labelled]);
    const reasons = [...new Set(Object.values(stream.stopped))];

    return (
        <div className="flex flex-col gap-2">
            <LogViewer
                log={log}
                name={name}
                searchable
                // Holding still is the point of pausing: new output would not
                // arrive anyway, and the reader is reading.
                autoScroll={!stream.paused}
                emptyText={emptyLiveText(stream.status)}
                className={className}
                header={
                    <>
                        {lead}
                        <LiveBadge status={stream.status} containers={stream.containerCount} />
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => stream.setPaused(!stream.paused)}
                            className="shrink-0"
                        >
                            {stream.paused ? <Play className="size-4" /> : <Pause className="size-4" />}
                            {stream.paused ? "Resume" : "Pause"}
                        </Button>
                    </>
                }
            />
            {(note || reasons.length > 0) && (
                <p className="text-xs text-muted-foreground">{[note, ...reasons].filter(Boolean).join(" ")}</p>
            )}
        </div>
    );
}

function emptyLiveText(status: LiveStatus): string {
    if (status === "connecting") return "Connecting...";
    if (status === "failed") return "Could not follow the logs. Reload the page to try again.";
    if (status === "paused") return "Paused.";
    return "Nothing has been printed yet.";
}

function LiveBadge({ status, containers }: { status: LiveStatus; containers: number }) {
    const label =
        status === "live"
            ? containers > 1
                ? `Live - ${containers} containers`
                : "Live"
            : status === "paused"
              ? "Paused"
              : status === "ended"
                ? "Output stopped - checking again shortly"
                : status === "failed"
                  ? "Disconnected"
                  : "Connecting";
    return (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span
                className={cn(
                    "size-1.5 rounded-full",
                    status === "live" ? "animate-pulse bg-success-solid" : status === "failed" ? "bg-danger" : "bg-muted-foreground/60"
                )}
            />
            {label}
        </span>
    );
}

interface HistoryLine extends StreamLine {
    readonly id: string;
    readonly stamp: string;
}

/**
 * A `datetime-local` value as the instant it names on the reader's clock - the
 * zone their display settings use, which is the zone the gutter shows, rather
 * than whatever zone the browser happens to be in.
 */
function instantOf(value: string, timeZone: string): string | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
    if (!match) return null;
    const [, year, month, day, hours, minutes] = match.map(Number) as number[];
    const date = zonedInstant(
        { year: year ?? 0, month: month ?? 1, day: day ?? 1, hours: hours ?? 0, minutes: minutes ?? 0 },
        timeZone
    );
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function HistoryLog({
    serviceIds,
    name,
    className,
    lead
}: {
    serviceIds: readonly string[];
    name: string;
    className?: string;
    lead: ReactNode;
}) {
    const [typed, setTyped] = useState("");
    const [query, setQuery] = useState("");
    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");
    // Newest first, as the pages arrive.
    const [lines, setLines] = useState<HistoryLine[] | null>(null);
    const [next, setNext] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [generation, setGeneration] = useState(0);
    const inFlight = useRef(false);
    // Which search a page belongs to, so an older page that lands after the
    // search changed is dropped rather than added to the wrong list.
    const epoch = useRef(0);
    const key = serviceIds.join(",");
    const timeZone = useDisplayFormat().preferences.timeZone;

    // Searched as it is typed, once the typing stops.
    useEffect(() => {
        const timer = setTimeout(() => setQuery(typed.trim()), 350);
        return () => clearTimeout(timer);
    }, [typed]);

    const fetchPage = useCallback(
        async (before: string | null): Promise<{ lines: HistoryLine[]; next: string | null } | null> => {
            const params = new URLSearchParams({ services: key, limit: String(HISTORY_PAGE) });
            if (query) params.set("q", query);
            const fromIso = instantOf(from, timeZone);
            const toIso = instantOf(to, timeZone);
            if (fromIso) params.set("from", fromIso);
            if (toIso) params.set("to", toIso);
            if (before) params.set("before", before);
            const res = await fetch(`/api/deploy/logs/search?${params.toString()}`, { cache: "no-store" });
            const data = (await res.json().catch(() => null)) as
                | { lines?: HistoryLine[]; next?: string | null; error?: string }
                | null;
            if (!res.ok || !data?.lines) {
                setError(data?.error ?? "Could not read the kept logs.");
                return null;
            }
            setError(null);
            return { lines: data.lines, next: data.next ?? null };
        },
        [key, query, from, to, timeZone]
    );

    // A new search starts from the newest line that matches it.
    useEffect(() => {
        epoch.current += 1;
        const mine = epoch.current;
        setLines(null);
        setNext(null);
        inFlight.current = true;
        setLoading(true);
        void fetchPage(null)
            .then((page) => {
                if (epoch.current !== mine) return;
                setLines(page?.lines ?? []);
                setNext(page?.next ?? null);
            })
            .finally(() => {
                if (epoch.current !== mine) return;
                inFlight.current = false;
                setLoading(false);
            });
    }, [fetchPage, generation]);

    const loadOlder = useCallback(
        (replace = false) => {
            if (inFlight.current || !next) return;
            if (!replace && (lines?.length ?? 0) >= HISTORY_CAP) return;
            const mine = epoch.current;
            inFlight.current = true;
            setLoading(true);
            void fetchPage(next)
                .then((page) => {
                    if (!page || epoch.current !== mine) return;
                    setLines((current) => (replace ? page.lines : [...(current ?? []), ...page.lines]));
                    setNext(page.next);
                })
                .finally(() => {
                    if (epoch.current !== mine) return;
                    inFlight.current = false;
                    setLoading(false);
                });
        },
        [fetchPage, next, lines]
    );

    const shown = useMemo(() => (lines ? lines.slice().reverse() : []), [lines]);
    const labelled = useMemo(() => new Set(shown.map((line) => `${line.serviceId}/${line.container}`)).size > 1, [shown]);
    const log = useMemo(() => formatStreamLog(shown, labelled), [shown, labelled]);
    const full = (lines?.length ?? 0) >= HISTORY_CAP;
    const filtered = Boolean(query || from || to);

    const start =
        lines === null || lines.length === 0 ? null : loading ? (
            <p className="flex items-center gap-2 px-3 py-1 text-[0.6875rem] text-zinc-500">
                <Loader2 className="size-3 animate-spin" /> Loading older lines...
            </p>
        ) : next && full ? (
            <p className="px-3 py-1 text-[0.6875rem] text-zinc-500">
                Showing the latest {HISTORY_CAP} lines.{" "}
                <button type="button" onClick={() => loadOlder(true)} className="text-zinc-300 underline-offset-2 hover:underline">
                    Read further back
                </button>
            </p>
        ) : next ? (
            <p className="px-3 py-1 text-[0.6875rem] text-zinc-500">
                <button type="button" onClick={() => loadOlder()} className="text-zinc-300 underline-offset-2 hover:underline">
                    Load older lines
                </button>
            </p>
        ) : (
            <p className="px-3 py-1 text-[0.6875rem] text-zinc-500">Nothing older is kept.</p>
        );

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
                <div className="relative min-w-[12rem] flex-1">
                    <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={typed}
                        onChange={(event) => setTyped(event.target.value)}
                        placeholder="Search kept logs"
                        className="h-8 pl-8 font-mono text-xs"
                        aria-label="Search kept logs"
                        maxLength={200}
                    />
                </div>
                <Input
                    type="datetime-local"
                    value={from}
                    max={to || undefined}
                    onChange={(event) => setFrom(event.target.value)}
                    className="h-8 w-auto text-xs"
                    aria-label="From"
                />
                <span className="text-muted-foreground">to</span>
                <Input
                    type="datetime-local"
                    value={to}
                    min={from || undefined}
                    onChange={(event) => setTo(event.target.value)}
                    className="h-8 w-auto text-xs"
                    aria-label="To"
                />
                {filtered && (
                    <button
                        type="button"
                        onClick={() => {
                            setTyped("");
                            setQuery("");
                            setFrom("");
                            setTo("");
                        }}
                        className="text-muted-foreground hover:text-foreground"
                    >
                        Clear
                    </button>
                )}
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <LogViewer
                log={log}
                name={`${name}-history`}
                withDates
                emptyText={
                    lines === null
                        ? "Loading..."
                        : filtered
                          ? "No kept lines match."
                          : "Nothing kept yet. Output is kept once a minute while a service runs."
                }
                className={className}
                onReachStart={() => loadOlder()}
                startSlot={start}
                header={
                    <>
                        {lead}
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setGeneration((value) => value + 1)}
                            disabled={loading}
                            className="shrink-0"
                        >
                            <RefreshCw className="size-4" />
                            Newest
                        </Button>
                    </>
                }
            />
        </div>
    );
}
