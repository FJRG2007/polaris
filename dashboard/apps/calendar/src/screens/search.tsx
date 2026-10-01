"use client";

/**
 * Finding an event: what is on screen matches as it is typed, and the server
 * is asked across all time (title, location, description, attendees) once two
 * letters are in. Picking a result opens the event.
 */

import { ColorDot } from "./ui";
import { useCalendarT } from "./i18n";
import { Button, cn, Input } from "@polaris/ui";
import { formatDay, formatInstant, wallOf } from "./time";
import type { OccurrenceView, SearchHit } from "../lib/wire";
import { Loader2, Search as SearchIcon, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

export interface SearchResult {
    readonly objectId: string;
    /** The occurrence to open, when one on screen matched. */
    readonly recurrenceKey: string | null;
    readonly title: string;
    readonly when: string;
    readonly color: string;
    readonly day: string | null;
}

/** Occurrences on screen whose title or place has every typed word. Pure. */
export function localMatches(occurrences: readonly OccurrenceView[], query: string): OccurrenceView[] {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const seen = new Set<string>();
    return occurrences.filter((occurrence) => {
        if (occurrence.busyOnly || seen.has(occurrence.objectId)) return false;
        const haystack = `${occurrence.summary} ${occurrence.location} ${occurrence.categories.join(" ")}`.toLowerCase();
        if (!words.every((word) => haystack.includes(word))) return false;
        seen.add(occurrence.objectId);
        return true;
    });
}

export function CalendarSearch({
    occurrences,
    colorOf,
    zone,
    locale,
    focusSignal,
    onOpen
}: {
    occurrences: readonly OccurrenceView[];
    colorOf: (calendarId: string, own: string | null) => string;
    zone: string;
    locale: string;
    /** Changes when `/` is pressed: the field takes the focus. */
    focusSignal: number;
    onOpen: (result: SearchResult) => void;
}) {
    const t = useCalendarT();
    const listId = useId();
    const input = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [hits, setHits] = useState<SearchHit[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [failed, setFailed] = useState(false);
    const [active, setActive] = useState(0);

    useEffect(() => {
        if (focusSignal === 0) return;
        setExpanded(true);
        setTimeout(() => input.current?.focus(), 0);
    }, [focusSignal]);

    // The server is asked once typing pauses; a newer question cancels the last.
    useEffect(() => {
        const text = query.trim();
        setFailed(false);
        if (text.length < 2) {
            setHits(null);
            setSearching(false);
            return;
        }
        const controller = new AbortController();
        setSearching(true);
        const timer = setTimeout(() => {
            fetch(`/api/calendar/search?q=${encodeURIComponent(text)}&zone=${encodeURIComponent(zone)}`, { cache: "no-store", signal: controller.signal })
                .then(async (response) => {
                    if (!response.ok) throw new Error(String(response.status));
                    const body = (await response.json()) as { hits?: SearchHit[] };
                    setHits(body.hits ?? []);
                })
                .catch(() => {
                    if (!controller.signal.aborted) setFailed(true);
                })
                .finally(() => {
                    if (!controller.signal.aborted) setSearching(false);
                });
        }, 250);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [query, zone]);

    const results = useMemo<SearchResult[]>(() => {
        const local = localMatches(occurrences, query).map((occurrence) => ({
            objectId: occurrence.objectId,
            recurrenceKey: occurrence.recurring ? occurrence.recurrenceKey : null,
            title: occurrence.summary || t("screen.untitled"),
            when: occurrence.allDay && occurrence.startDate ? formatDay(occurrence.startDate, locale, { dateStyle: "medium" }) : formatInstant(occurrence.start, locale, zone, { dateStyle: "medium", timeStyle: "short" }),
            color: colorOf(occurrence.calendarId, occurrence.color),
            day: occurrence.startDate ?? wallOf(occurrence.start, zone).slice(0, 10)
        }));
        const shown = new Set(local.map((result) => result.objectId));
        const remote = (hits ?? [])
            .filter((hit) => !shown.has(hit.objectId))
            .map((hit) => ({
                objectId: hit.objectId,
                recurrenceKey: null,
                title: hit.summary || t("screen.untitled"),
                when: hit.start ? (hit.allDay ? formatDay(wallOf(hit.start, zone).slice(0, 10), locale, { dateStyle: "medium" }) : formatInstant(hit.start, locale, zone, { dateStyle: "medium", timeStyle: "short" })) : "",
                color: colorOf(hit.calendarId, hit.color),
                day: hit.start ? wallOf(hit.start, zone).slice(0, 10) : null
            }));
        return [...local, ...remote].slice(0, 30);
    }, [occurrences, query, hits, colorOf, locale, zone, t]);

    const pick = (result: SearchResult) => {
        onOpen(result);
        setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActive((index) => Math.min(results.length - 1, index + 1));
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(0, index - 1));
        } else if (event.key === "Enter") {
            const result = results[active];
            if (result) {
                event.preventDefault();
                pick(result);
            }
        } else if (event.key === "Escape") {
            event.preventDefault();
            if (query) setQuery("");
            else {
                setOpen(false);
                setExpanded(false);
                input.current?.blur();
            }
        }
    };

    const showList = open && query.trim().length > 0;

    return (
        <div className={cn("relative min-w-0", expanded ? "flex-1 sm:w-64 sm:flex-none" : "")}>
            {!expanded ? (
                <Button size="icon-sm" variant="ghost" className="sm:hidden" aria-label={t("search.label")} title={t("search.label")} onClick={() => {
                    setExpanded(true);
                    setTimeout(() => input.current?.focus(), 0);
                }}>
                    <SearchIcon />
                </Button>
            ) : null}
            <div className={cn("relative", expanded ? "block" : "hidden sm:block")}>
                <SearchIcon aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
                <Input
                    ref={input}
                    type="search"
                    role="combobox"
                    aria-label={t("search.label")}
                    aria-expanded={showList}
                    aria-controls={listId}
                    aria-activedescendant={showList && results[active] ? `${listId}-${active}` : undefined}
                    placeholder={t("search.placeholder")}
                    className="h-7 w-full pl-8 pr-7 sm:w-56"
                    value={query}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setActive(0);
                        setOpen(true);
                    }}
                    onFocus={() => setOpen(true)}
                    onBlur={() => setTimeout(() => setOpen(false), 150)}
                    onKeyDown={onKeyDown}
                />
                {query ? (
                    <button type="button" aria-label={t("search.clear")} title={t("search.clear")} className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground-subtle hover:text-foreground" onClick={() => setQuery("")}>
                        <X className="size-3.5" />
                    </button>
                ) : null}
            </div>
            {showList ? (
                <div className="absolute right-0 top-full z-40 mt-1 w-[min(24rem,calc(100vw-1.5rem))] rounded-lg border border-border-strong bg-elevated p-1 shadow-popover">
                    <ul id={listId} role="listbox" aria-label={t("search.results")} className="max-h-80 overflow-y-auto">
                        {results.map((result, index) => (
                            <li
                                key={`${result.objectId}-${result.recurrenceKey ?? ""}`}
                                id={`${listId}-${index}`}
                                role="option"
                                aria-selected={index === active}
                                onMouseDown={(event) => {
                                    event.preventDefault();
                                    pick(result);
                                }}
                                onMouseEnter={() => setActive(index)}
                                className={cn("flex min-w-0 cursor-pointer items-center gap-2 rounded px-2 py-1.5", index === active && "bg-option-hover")}
                            >
                                <ColorDot color={result.color} />
                                <span className="min-w-0 flex-1 truncate text-[0.8125rem]" title={result.title}>
                                    {result.title}
                                </span>
                                <span className="shrink-0 text-xs text-foreground-subtle tabular-nums">{result.when}</span>
                            </li>
                        ))}
                    </ul>
                    {searching ? (
                        <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                            <Loader2 aria-hidden className="size-3.5 animate-spin" />
                            {t("search.searching")}
                        </p>
                    ) : failed ? (
                        <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("search.failed")}</p>
                    ) : results.length === 0 ? (
                        <p className="px-2 py-1.5 text-xs text-muted-foreground">{query.trim().length < 2 ? t("search.keepTyping") : t("search.none")}</p>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
