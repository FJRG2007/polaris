"use client";

/**
 * An audit trail on screen: narrowed, paged, and exportable.
 *
 * Shared by the three screens that read the trail - the whole deployment, one
 * organization, one account - so they narrow the same way, page the same way and
 * export the same way. What differs is passed in: where the rows come from, what
 * the second column says, and whatever filter is that screen's own (a person for
 * an organization, a session for an account).
 *
 * **The narrowing lives in the URL.** A reader can hand "what Ana did to the
 * roster last week" to somebody else as a link, and the back button undoes a
 * filter. Every change re-asks the server rather than hiding rows already
 * fetched: the trail is paged, and what somebody is looking for is usually on a
 * page they have not loaded.
 *
 * **The first page is polled; the rest are not.** New entries arrive at the top,
 * and polling a page while older ones hang below it would open a gap between the
 * two. So the poll stops once somebody has scrolled into older history, and
 * resumes when they narrow again.
 */

import * as core from "@polaris/core";
import type { AuditEntry } from "@/lib/audit-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useLiveResource } from "@/components/use-live-resource";
import { Download, Loader2, RefreshCw, Search, X } from "lucide-react";
import { ActivityTable, type ActivityRow } from "@/components/activity-table";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Input,
    Select
} from "@polaris/ui";

/** How often the first page re-reads. An audit trail is appended to, not
 *  edited, so this is gentle - the refresh control covers wanting it now. */
const POLL_MS = 30_000;

/** How long typing settles before the phrase narrows the trail. */
const SEARCH_SETTLE_MS = 350;

/** Radix refuses an empty option value, so "no narrowing" is named. */
const ALL = "all";

/** The parameters this component owns in the URL. A screen's own filter (the
 *  session) is left alone. */
const FILTER_KEYS = ["actor", "area", "resource", "q", "from", "to"] as const;

export interface AuditFacetsView {
    readonly actors: { id: string; name: string }[];
    readonly areas: string[];
    readonly resources: string[];
}

interface AuditPage {
    items: AuditEntry[];
    nextCursor: string | null;
    facets?: AuditFacetsView;
}

/** "drive.file" reads as "Drive file". */
function areaLabel(area: string): string {
    const words = area.replace(/[.\-_]+/g, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A moment as a `datetime-local` input writes it, and back. */
function toInput(iso: string | null): string {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
}

function fromInput(value: string): string | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function AuditFeed({
    endpoint,
    exportEndpoint,
    path,
    cacheKey,
    contextLabel,
    emptyLabel,
    context,
    detail,
    showActor = true,
    extra,
    ownFilter,
    onPage
}: {
    /** Where the pages come from. */
    endpoint: string;
    /** Where the file comes from; the same narrowing is sent. */
    exportEndpoint: string;
    /** This screen's own address, for writing the narrowing into the URL. */
    path: string;
    cacheKey: string;
    contextLabel: string;
    emptyLabel: string;
    /** What the second column says about one entry. */
    context: (entry: AuditEntry) => string;
    /** What the line under the action says, when it says anything. */
    detail?: (entry: AuditEntry) => string;
    /** Whether "who did it" is a question here. Not on somebody's own history. */
    showActor?: boolean;
    /** This screen's own parameter, sent with every request and export. */
    extra?: { key: string; value: string | null };
    /** This screen's own filter control, drawn first in the toolbar. */
    ownFilter?: ReactNode;
    /** The raw first page, for a screen that reads more than the rows off it. */
    onPage?: (body: unknown) => void;
}) {
    const router = useRouter();
    const params = useSearchParams();

    const filters = useMemo(() => {
        const out = new URLSearchParams();
        for (const key of FILTER_KEYS) {
            const value = params.get(key);
            if (value) out.set(key, value);
        }
        if (extra?.value) out.set(extra.key, extra.value);
        return out;
    }, [params, extra?.key, extra?.value]);
    const query = filters.toString();
    const narrowed = FILTER_KEYS.some((key) => params.get(key));

    const [older, setOlder] = useState<AuditEntry[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const [olderError, setOlderError] = useState<string | null>(null);

    const onPageRef = useRef(onPage);
    onPageRef.current = onPage;
    const { data, loading, error, stale, refreshing, refresh } = useLiveResource<AuditPage>({
        url: `${endpoint}${query ? `?${query}` : ""}`,
        cacheKey: `${cacheKey}:${query}`,
        intervalMs: POLL_MS,
        // See the header: a polled first page above loaded older pages leaves a
        // gap between them, so polling stops once older history is on screen.
        paused: older.length > 0,
        select: (body) => {
            onPageRef.current?.(body);
            const page = body as Partial<AuditPage>;
            return {
                items: Array.isArray(page.items) ? page.items : [],
                nextCursor: typeof page.nextCursor === "string" ? page.nextCursor : null,
                facets: page.facets
            };
        }
    });

    // A new narrowing is a new list: the older pages belonged to the last one.
    useEffect(() => {
        setOlder([]);
        setCursor(null);
        setOlderError(null);
    }, [query]);

    const nextCursor = older.length > 0 ? cursor : (data?.nextCursor ?? null);

    const loadOlder = useCallback(async () => {
        if (!nextCursor || loadingOlder) return;
        setLoadingOlder(true);
        setOlderError(null);
        try {
            const next = new URLSearchParams(filters);
            next.set("cursor", nextCursor);
            const response = await fetch(`${endpoint}?${next.toString()}`, { cache: "no-store" });
            const body = (await response.json().catch(() => null)) as Partial<AuditPage> & {
                error?: string;
            } | null;
            if (!response.ok || !body) throw new Error(body?.error ?? "Older entries could not be loaded");
            const items = Array.isArray(body.items) ? body.items : [];
            setOlder((held) => [...held, ...items]);
            setCursor(typeof body.nextCursor === "string" ? body.nextCursor : null);
        } catch (caught) {
            setOlderError(caught instanceof Error ? caught.message : "Older entries could not be loaded");
        } finally {
            setLoadingOlder(false);
        }
    }, [endpoint, filters, loadingOlder, nextCursor]);

    // The next page is asked for as the end of the list comes into view, so the
    // trail reads as one long list rather than a pager.
    const sentinel = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const node = sentinel.current;
        if (!node || !nextCursor) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) void loadOlder();
            },
            { rootMargin: "400px" }
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [loadOlder, nextCursor]);

    const setFilter = useCallback(
        (key: (typeof FILTER_KEYS)[number], value: string | null) => {
            const next = new URLSearchParams(params.toString());
            if (value) next.set(key, value);
            else next.delete(key);
            const written = next.toString();
            router.replace(written ? `${path}?${written}` : path, { scroll: false });
        },
        [params, path, router]
    );

    const clear = useCallback(() => {
        const next = new URLSearchParams(params.toString());
        for (const key of FILTER_KEYS) next.delete(key);
        const written = next.toString();
        router.replace(written ? `${path}?${written}` : path, { scroll: false });
    }, [params, path, router]);

    // The phrase narrows once typing settles, not on every keystroke.
    const [phrase, setPhrase] = useState(params.get("q") ?? "");
    useEffect(() => setPhrase(params.get("q") ?? ""), [params]);
    useEffect(() => {
        if (phrase === (params.get("q") ?? "")) return;
        const timer = setTimeout(() => setFilter("q", phrase.trim() || null), SEARCH_SETTLE_MS);
        return () => clearTimeout(timer);
    }, [phrase, params, setFilter]);

    const facets = data?.facets;
    const entries = [...(data?.items ?? []), ...older];
    const rows: ActivityRow[] | null = data
        ? entries.map((entry) => ({
              id: entry.id,
              at: entry.at,
              context: context(entry),
              action: entry.action,
              detail: detail?.(entry),
              metadata: entry.metadata
          }))
        : null;

    const exportHref = (format: core.AuditExportFormat) => {
        const next = new URLSearchParams(filters);
        next.set("format", format);
        return `${exportEndpoint}?${next.toString()}`;
    };

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                {ownFilter}
                {showActor ? (
                    <Select
                        value={params.get("actor") ?? ALL}
                        onValueChange={(value) => setFilter("actor", value === ALL ? null : value)}
                        aria-label="Filter by person"
                        className="h-8 w-full sm:w-48"
                        options={[
                            { value: ALL, label: "Everybody" },
                            ...(facets?.actors ?? []).map((actor) => ({ value: actor.id, label: actor.name }))
                        ]}
                    />
                ) : null}
                <Select
                    value={params.get("area") ?? ALL}
                    onValueChange={(value) => setFilter("area", value === ALL ? null : value)}
                    aria-label="Filter by area"
                    className="h-8 w-full sm:w-40"
                    options={[
                        { value: ALL, label: "Every area" },
                        ...(facets?.areas ?? []).map((area) => ({ value: area, label: areaLabel(area) }))
                    ]}
                />
                <Select
                    value={params.get("resource") ?? ALL}
                    onValueChange={(value) => setFilter("resource", value === ALL ? null : value)}
                    aria-label="Filter by what was acted on"
                    className="h-8 w-full sm:w-40"
                    options={[
                        { value: ALL, label: "Anything" },
                        ...(facets?.resources ?? []).map((resource) => ({
                            value: resource,
                            label: areaLabel(resource)
                        }))
                    ]}
                />
                <label className="relative w-full sm:w-52">
                    <Search
                        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtle"
                        aria-hidden
                    />
                    <Input
                        value={phrase}
                        onChange={(event) => setPhrase(event.target.value)}
                        placeholder="Search actions and details"
                        aria-label="Search actions and details"
                        maxLength={200}
                        className="h-8 pl-8"
                    />
                </label>
                <Input
                    type="datetime-local"
                    value={toInput(params.get("from"))}
                    onChange={(event) => setFilter("from", fromInput(event.target.value))}
                    aria-label="From"
                    title="From"
                    className="h-8 w-full sm:w-auto"
                />
                <Input
                    type="datetime-local"
                    value={toInput(params.get("to"))}
                    onChange={(event) => setFilter("to", fromInput(event.target.value))}
                    aria-label="To"
                    title="To"
                    className="h-8 w-full sm:w-auto"
                />
                {narrowed ? (
                    <Button variant="ghost" size="sm" onClick={clear}>
                        <X className="size-3.5" aria-hidden />
                        Clear
                    </Button>
                ) : null}
                <div className="ml-auto flex items-center gap-1">
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label="Export" title="Export">
                                <Download className="size-4" aria-hidden />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                                <a href={exportHref("csv")} download>
                                    Export as CSV
                                </a>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                                <a href={exportHref("json")} download>
                                    Export as JSON
                                </a>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={refresh}
                        disabled={refreshing}
                        aria-label="Refresh"
                        title="Refresh"
                    >
                        <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} aria-hidden />
                    </Button>
                </div>
            </div>

            {stale ? <p className="text-sm text-warning">{stale}</p> : null}

            <ActivityTable
                rows={rows}
                loading={loading}
                error={error}
                contextLabel={contextLabel}
                emptyLabel={narrowed ? "Nothing matches these filters." : emptyLabel}
            />

            {nextCursor ? (
                <div ref={sentinel} className="flex justify-center py-2">
                    <Button variant="ghost" size="sm" onClick={() => void loadOlder()} disabled={loadingOlder}>
                        {loadingOlder ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
                        {loadingOlder ? "Loading older entries" : "Load older entries"}
                    </Button>
                </div>
            ) : null}
            {olderError ? <p className="text-center text-sm text-danger">{olderError}</p> : null}
        </div>
    );
}
