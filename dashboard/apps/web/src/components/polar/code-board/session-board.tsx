"use client";

/**
 * Polar Code's session board: every session in reach, in the column its
 * derived status puts it - who has to act next, at a glance.
 *
 * The page draws its chrome at once and the board fills in: the last board
 * read under these filters is kept in the browser and shown straight away,
 * then read again and swapped only when it changed. After that the board
 * follows its sessions on a live stream (`/api/polar/code/board/live`) and
 * reads itself again on a slow timer for sessions started since.
 *
 * The filters are the viewer's own and are remembered in this browser. On a
 * phone the columns are tabs and one is shown at a time; from a tablet up
 * they sit side by side and scroll sideways.
 */

import Link from "next/link";
import * as ui from "@polaris/ui";
import { AGENT_CLIS } from "@polaris/core";
import { readPoll } from "@/lib/poll-fetch";
import * as board from "@/lib/agents/session-board";
import { PagedPicker } from "@/components/paged-picker";
import { readStored, writeStored } from "@/lib/polar/stored";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { boardOptionsAction } from "@/app/(app)/polar/board/actions";
import { LayoutGrid, Plus, RefreshCw, SearchX, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BoardAnswer, BoardCard, DonePage } from "@/lib/polar/code-board";
import { BoardColumnBody, boardColumnTone } from "@/components/polar/code-board/board-column";

const FILTERS_KEY = "polar.board.filters";
const CACHE_PREFIX = "polar.board.cache:";
const COLUMN_KEY = "polar.board.column";
/** How often the board reads itself again for sessions started since. */
const SLOW_POLL_MS = 30_000;
const ALL = "all";

const TONE_DOT: Record<ReturnType<typeof boardColumnTone>, string> = {
    neutral: "bg-foreground-subtle",
    primary: "bg-primary",
    success: "bg-success-ink",
    warning: "bg-warning-ink",
    danger: "bg-danger-ink"
};

function readCache(query: string): BoardAnswer | null {
    const raw = readStored(CACHE_PREFIX + query);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as BoardAnswer;
        return Array.isArray(parsed?.cards) ? parsed : null;
    } catch {
        return null;
    }
}

export function SessionBoard({
    canRead,
    canStart,
    viewerId
}: {
    canRead: boolean;
    canStart: boolean;
    viewerId: string;
}) {
    const t = useTranslations("polar");
    const toast = ui.useToast();
    const [filters, setFilters] = useState<board.BoardFilters | null>(null);
    const [answer, setAnswer] = useState<BoardAnswer | null>(null);
    const [failed, setFailed] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [moreDone, setMoreDone] = useState<{ cards: BoardCard[]; next: string | null } | null>(null);
    const [loadingDone, setLoadingDone] = useState(false);
    const [column, setColumn] = useState<board.BoardColumn>("needs_you");
    const query = filters ? board.filterQuery(filters) : null;
    const reading = useRef<AbortController | null>(null);

    // Read in an effect: the server has no storage, and the first render must
    // match the one it drew.
    useEffect(() => {
        setFilters(board.storedFilters(readStored(FILTERS_KEY)));
        const stored = readStored(COLUMN_KEY);
        if (stored && (board.BOARD_COLUMNS as readonly string[]).includes(stored))
            setColumn(stored as board.BoardColumn);
    }, []);

    const read = useCallback(async (current: string) => {
        reading.current?.abort();
        const controller = new AbortController();
        reading.current = controller;
        setRefreshing(true);
        try {
            const fresh = await readPoll<BoardAnswer>(
                "/api/polar/code/board",
                Object.fromEntries(new URLSearchParams(current)),
                controller.signal
            );
            if (controller.signal.aborted) return;
            const text = JSON.stringify(fresh);
            writeStored(CACHE_PREFIX + current, text);
            setAnswer((before) => (before && JSON.stringify(before) === text ? before : fresh));
            setFailed(false);
        } catch {
            if (!controller.signal.aborted) setFailed(true);
        } finally {
            if (reading.current === controller) setRefreshing(false);
        }
    }, []);

    // A new filter: what was last seen under it at once, then the fresh read.
    useEffect(() => {
        if (query === null || !canRead) return;
        setAnswer(readCache(query));
        setMoreDone(null);
        setFailed(false);
        void read(query);
        return () => reading.current?.abort();
    }, [query, canRead, read]);

    // The live stream for the running sessions on screen, reopened when they
    // change, and the slow read for the ones started since.
    const liveKey = useMemo(
        () =>
            answer?.cards
                .filter((card) => card.column !== "done")
                .map((card) => card.id)
                .join(",") ?? "",
        [answer]
    );
    useEffect(() => {
        if (query === null || !canRead || typeof EventSource === "undefined") return;
        const source = new EventSource(`/api/polar/code/board/live${query ? `?${query}` : ""}`);
        source.addEventListener("change", () => void read(query));
        return () => source.close();
    }, [query, canRead, liveKey, read]);
    useEffect(() => {
        if (query === null || !canRead) return;
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") void read(query);
        }, SLOW_POLL_MS);
        return () => clearInterval(timer);
    }, [query, canRead, read]);

    const change = (next: board.BoardFilters) => {
        setFilters(next);
        writeStored(FILTERS_KEY, JSON.stringify(next));
    };
    const pickColumn = (next: board.BoardColumn) => {
        setColumn(next);
        writeStored(COLUMN_KEY, next);
    };

    const doneNext = moreDone ? moreDone.next : (answer?.doneNext ?? null);
    const loadMoreDone = async () => {
        if (!doneNext || filters === null) return;
        setLoadingDone(true);
        try {
            const page = await readPoll<DonePage>(
                "/api/polar/code/board",
                Object.fromEntries(new URLSearchParams(board.filterQuery(filters, doneNext)))
            );
            setMoreDone((before) => ({ cards: [...(before?.cards ?? []), ...page.cards], next: page.doneNext }));
        } catch {
            toast.show({ title: t("board.loadFailed") });
        } finally {
            setLoadingDone(false);
        }
    };

    const grouped = useMemo(() => {
        const out = new Map<board.BoardColumn, BoardCard[]>(board.BOARD_COLUMNS.map((key) => [key, []]));
        const seen = new Set<string>();
        for (const card of [...(answer?.cards ?? []), ...(moreDone?.cards ?? [])]) {
            if (seen.has(card.id)) continue;
            seen.add(card.id);
            out.get(card.column)?.push(card);
        }
        return out;
    }, [answer, moreDone]);

    const filtered = Boolean(filters && (filters.repo || filters.agent || filters.person));
    const loading = answer === null && !failed;
    const empty = answer !== null && answer.cards.length === 0;
    const count = (key: board.BoardColumn) => grouped.get(key)?.length ?? 0;

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
            <header className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <LayoutGrid className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <h1 className="truncate text-[1.0625rem] font-semibold leading-tight tracking-tight">
                        {t("board.title")}
                    </h1>
                    {refreshing && answer ? (
                        <RefreshCw
                            className="size-3.5 shrink-0 text-foreground-subtle motion-safe:animate-spin"
                            aria-label={t("board.refreshing")}
                        />
                    ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    {canStart ? null : (
                        <ui.Button asChild variant="ghost" size="sm" className="[@media(pointer:coarse)]:h-11">
                            <Link href="/polar" prefetch={false}>
                                {t("board.openCode")}
                            </Link>
                        </ui.Button>
                    )}
                    {canStart ? (
                        <ui.Button asChild variant="primary" size="sm" className="[@media(pointer:coarse)]:h-11">
                            <Link href="/polar?session=new" prefetch={false}>
                                <Plus className="size-4" aria-hidden />
                                {t("code.newTask")}
                            </Link>
                        </ui.Button>
                    ) : null}
                </div>
            </header>

            {!canRead ? (
                <ui.EmptyState icon={<LayoutGrid />} title={t("board.noAccess")} description={t("board.noAccessHint")} />
            ) : (
                <>
                    <BoardFilters filters={filters} onChange={change} filtered={filtered} />
                    {failed && answer ? (
                        <p role="status" className="text-[0.75rem] text-warning-ink">
                            {t("board.staleNotice")}
                        </p>
                    ) : null}
                    {answer?.truncated ? (
                        <p role="status" className="text-[0.75rem] text-muted-foreground">
                            {t("board.truncated")}
                        </p>
                    ) : null}
                    {failed && !answer ? (
                        <ui.EmptyState
                            icon={<RefreshCw />}
                            title={t("board.loadFailed")}
                            action={
                                <ui.Button variant="outline" size="sm" onClick={() => query !== null && void read(query)}>
                                    {t("code.retry")}
                                </ui.Button>
                            }
                        />
                    ) : empty && filtered ? (
                        <ui.EmptyState
                            icon={<SearchX />}
                            title={t("board.noMatch")}
                            action={
                                <ui.Button variant="outline" size="sm" onClick={() => change({})}>
                                    {t("board.clearFilters")}
                                </ui.Button>
                            }
                        />
                    ) : empty ? (
                        <ui.EmptyState
                            icon={<LayoutGrid />}
                            title={t("board.empty")}
                            description={canStart ? t("board.emptyHint") : undefined}
                            action={
                                canStart ? (
                                    <ui.Button asChild variant="primary" size="sm">
                                        <Link href="/polar?session=new" prefetch={false}>
                                            {t("code.newTask")}
                                        </Link>
                                    </ui.Button>
                                ) : undefined
                            }
                        />
                    ) : (
                        <>
                            <ui.ScrollRow
                                as="div"
                                role="tablist"
                                aria-label={t("board.columnsLabel")}
                                className="flex shrink-0 gap-1 md:hidden"
                            >
                                {board.BOARD_COLUMNS.map((key) => (
                                    <button
                                        key={key}
                                        type="button"
                                        role="tab"
                                        aria-selected={column === key}
                                        aria-controls={`board-column-${key}`}
                                        onClick={() => pickColumn(key)}
                                        className={ui.cn(
                                            "flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[0.8125rem] transition-colors [@media(pointer:coarse)]:h-11",
                                            column === key
                                                ? "bg-muted font-medium text-foreground"
                                                : "text-muted-foreground hover:bg-card-hover hover:text-foreground"
                                        )}
                                    >
                                        <span className={ui.cn("size-1.5 rounded-full", TONE_DOT[boardColumnTone(key)])} aria-hidden />
                                        {t(`board.columns.${key}`)}
                                        {loading ? null : (
                                            <span className="tabular-nums text-foreground-subtle">{count(key)}</span>
                                        )}
                                    </button>
                                ))}
                            </ui.ScrollRow>
                            <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto overscroll-x-contain md:snap-x md:snap-mandatory">
                                {board.BOARD_COLUMNS.map((key) => (
                                    <section
                                        key={key}
                                        id={`board-column-${key}`}
                                        aria-labelledby={`board-column-${key}-title`}
                                        className={ui.cn(
                                            "min-h-0 w-full min-w-0 flex-col rounded-lg bg-muted/40 md:flex md:w-72 md:shrink-0 md:snap-start 2xl:w-auto 2xl:min-w-72 2xl:flex-1",
                                            column === key ? "flex" : "hidden"
                                        )}
                                    >
                                        <div className="flex min-w-0 shrink-0 items-center gap-2 px-3 pb-1 pt-2.5">
                                            <span className={ui.cn("size-2 shrink-0 rounded-full", TONE_DOT[boardColumnTone(key)])} aria-hidden />
                                            <h2
                                                id={`board-column-${key}-title`}
                                                className="min-w-0 truncate text-[0.8125rem] font-medium"
                                            >
                                                {t(`board.columns.${key}`)}
                                            </h2>
                                            {loading ? null : (
                                                <span className="tabular-nums text-[0.75rem] text-foreground-subtle">
                                                    {count(key)}
                                                </span>
                                            )}
                                        </div>
                                        <BoardColumnBody
                                            column={key}
                                            cards={grouped.get(key) ?? []}
                                            loading={loading}
                                            viewerId={viewerId}
                                            footer={
                                                key === "done" && doneNext ? (
                                                    <ui.Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="mt-2 w-full"
                                                        disabled={loadingDone}
                                                        onClick={() => void loadMoreDone()}
                                                    >
                                                        {t("board.moreDone")}
                                                    </ui.Button>
                                                ) : null
                                            }
                                        />
                                    </section>
                                ))}
                            </div>
                        </>
                    )}
                </>
            )}
        </div>
    );
}

type Option = { id: string; name: string };

function BoardFilters({
    filters,
    onChange,
    filtered
}: {
    filters: board.BoardFilters | null;
    onChange: (next: board.BoardFilters) => void;
    filtered: boolean;
}) {
    const t = useTranslations("polar");
    const current = filters ?? {};
    const set = (key: keyof board.BoardFilters, value: string) => {
        const next = { ...current };
        if (value === ALL) delete next[key];
        else next[key] = value;
        onChange(next);
    };
    const agents = useMemo(
        () => [
            { value: ALL, label: t("board.allAgents") },
            ...AGENT_CLIS.map((cli) => ({ value: cli.id, label: cli.label }))
        ],
        [t]
    );
    return (
        <div className="grid min-w-0 shrink-0 grid-cols-1 gap-2 sm:grid-cols-[repeat(3,minmax(0,14rem))_auto] sm:items-center [@media(pointer:coarse)]:[&_button]:min-h-11">
            <PagedPicker<Option>
                read={boardOptionsAction}
                scope={{ kind: "repo" }}
                cache="polar-board-repos"
                value={current.repo ?? ALL}
                onValueChange={(id) => set("repo", id)}
                fixed={[{ value: ALL, label: t("board.allRepos") }]}
                placeholder={t("board.allRepos")}
                searchPlaceholder={t("code.searchRepos")}
                emptyText={t("code.noRepoMatch")}
                aria-label={t("board.repoFilter")}
                disabled={filters === null}
            />
            <ui.Select
                value={current.agent ?? ALL}
                onValueChange={(value) => set("agent", value)}
                options={agents}
                aria-label={t("board.agentFilter")}
                disabled={filters === null}
            />
            <PagedPicker<Option>
                read={boardOptionsAction}
                scope={{ kind: "person" }}
                cache="polar-board-people"
                value={current.person ?? ALL}
                onValueChange={(id) => set("person", id)}
                fixed={[{ value: ALL, label: t("board.allPeople") }]}
                placeholder={t("board.allPeople")}
                searchPlaceholder={t("board.searchPeople")}
                emptyText={t("board.noPersonMatch")}
                aria-label={t("board.personFilter")}
                disabled={filters === null}
            />
            {filtered ? (
                <ui.Button variant="ghost" size="sm" className="justify-self-start" onClick={() => onChange({})}>
                    <X className="size-4" aria-hidden />
                    {t("board.clearFilters")}
                </ui.Button>
            ) : null}
        </div>
    );
}
