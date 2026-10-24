"use client";

/**
 * The docs search, drawn with the dashboard's own search panel: Ctrl+K, Cmd+K
 * or / opens it, the arrows move through results grouped by page, Enter opens
 * one, and the last few opened come back when the field is empty. Nothing is
 * downloaded until it first opens: then the titles and headings, so typing can
 * start at once, and the section texts in chunks right after.
 */

import { groupRows, searchTerms, stepActive } from "@polaris/ui/search-match";
import { Clock, CornerDownLeft, FileText, Hash, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
    SearchGroup,
    SearchHighlight,
    SearchOption,
    SearchPalette,
    SearchTrigger
} from "@polaris/ui/search-palette";
import {
    joinIndex,
    parseRecent,
    rememberRecent,
    searchIndex,
    snippet,
    type RecentSearch,
    type SearchManifest,
    type SearchRecord
} from "@/lib/search-index";
import { opensSearch } from "@/lib/search-shortcut";

/** The words the panel shows, in the page's language. */
export interface DocsSearchWords {
    readonly search: string;
    readonly open: string;
    readonly empty: string;
    readonly emptyRecent: string;
    readonly loading: string;
    readonly failed: string;
    readonly recent: string;
    readonly clear: string;
    readonly forget: string;
    readonly forgetNamed: string;
    readonly results: string;
    readonly hintMove: string;
    readonly hintClose: string;
}

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const at = (path: string) => `${BASE}/${path}`;

interface Loaded {
    manifest: SearchManifest;
    chunks: Map<number, readonly string[]>;
}

const indexes = new Map<string, Promise<SearchManifest>>();

/** One request per manifest for the life of the page; a failed one is tried again on the next open. */
function loadManifest(locale: string): Promise<SearchManifest> {
    let pending = indexes.get(locale);
    if (!pending) {
        pending = fetch(at(`search/${locale}/manifest.json`)).then((response) => {
            if (!response.ok) throw new Error(`${response.status}`);
            return response.json() as Promise<SearchManifest>;
        });
        pending.catch(() => indexes.delete(locale));
        indexes.set(locale, pending);
    }
    return pending;
}

const recentKey = (locale: string) => `polaris.docs.recent.${locale}`;

function readRecent(locale: string): RecentSearch[] {
    try {
        return parseRecent(window.localStorage.getItem(recentKey(locale)));
    } catch {
        return [];
    }
}

function writeRecent(locale: string, list: readonly RecentSearch[]): void {
    try {
        if (list.length) window.localStorage.setItem(recentKey(locale), JSON.stringify(list));
        else window.localStorage.removeItem(recentKey(locale));
    } catch {
        // Storage refused (private window, blocked site data): recents last this visit only.
    }
}

type Row =
    | { kind: "recent"; id: string; group: string; entry: RecentSearch }
    | { kind: "hit"; id: string; group: string; record: SearchRecord };

const rowId = (index: number) => `docs-search-row-${index}`;

export function DocsSearch({
    locale,
    words,
    className
}: {
    locale: string;
    words: DocsSearchWords;
    className?: string;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [failed, setFailed] = useState(false);
    const [recent, setRecent] = useState<RecentSearch[]>([]);
    const [hint, setHint] = useState("Ctrl K");
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) setHint("⌘K");
        const onKey = (event: globalThis.KeyboardEvent) => {
            if (!opensSearch(event)) return;
            // Browsers put Ctrl+K on the address bar; the docs claim it here.
            event.preventDefault();
            setOpen((value) => !value);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    // First open: the manifest, then every text chunk at once.
    useEffect(() => {
        if (!open) return;
        setRecent(readRecent(locale));
        if (loaded) return;
        let live = true;
        setFailed(false);
        loadManifest(locale).then(
            (manifest) => {
                if (!live) return;
                const chunks = new Map<number, readonly string[]>();
                setLoaded({ manifest, chunks });
                manifest.chunks.forEach((file, index) => {
                    fetch(at(`search/${locale}/${file}`))
                        .then((response) => (response.ok ? response.json() : null))
                        .then((texts: readonly string[] | null) => {
                            if (!texts || !Array.isArray(texts)) return;
                            setLoaded((current) =>
                                current
                                    ? {
                                          manifest: current.manifest,
                                          chunks: new Map(current.chunks).set(index, texts)
                                      }
                                    : current
                            );
                        })
                        // A chunk that fails leaves its sections findable by title.
                        .catch(() => undefined);
                });
            },
            () => live && setFailed(true)
        );
        return () => {
            live = false;
        };
    }, [open, loaded, locale]);

    const records = useMemo(
        () => (loaded ? joinIndex(loaded.manifest, loaded.chunks) : []),
        [loaded]
    );
    const trimmed = query.trim();
    const terms = useMemo(() => searchTerms(trimmed), [trimmed]);
    const rows = useMemo<Row[]>(() => {
        if (!trimmed)
            return recent.map((entry, index) => ({
                kind: "recent",
                id: `recent-${index}`,
                group: words.recent,
                entry
            }));
        return searchIndex(records, trimmed).flatMap((group) =>
            group.records.map((record) => ({
                kind: "hit" as const,
                id: record.href,
                group: group.page,
                record
            }))
        );
    }, [trimmed, recent, records, words.recent]);
    const groups = useMemo(() => groupRows(rows, (row) => row.group), [rows]);

    useEffect(() => setActive(0), [trimmed]);
    useEffect(() => {
        listRef.current
            ?.querySelector('[data-active="true"]')
            ?.scrollIntoView({ block: "nearest" });
    }, [active, rows]);

    const onOpenChange = useCallback((next: boolean) => {
        setOpen(next);
        if (!next) setQuery("");
    }, []);

    function go(row: Row | undefined) {
        if (!row) return;
        const entry: RecentSearch =
            row.kind === "recent"
                ? row.entry
                : { title: row.record.title, page: row.record.page, href: row.record.href };
        const next = rememberRecent(readRecent(locale), entry);
        writeRecent(locale, next);
        setRecent(next);
        setOpen(false);
        setQuery("");
        window.location.assign(at(entry.href));
    }

    function forget(entry: RecentSearch) {
        const next = recent.filter((one) => one.href !== entry.href);
        writeRecent(locale, next);
        setRecent(next);
    }

    function onFieldKeyDown(event: KeyboardEvent<HTMLInputElement>) {
        const next = stepActive(event.key, active, rows.length);
        if (next !== null) {
            event.preventDefault();
            setActive(next);
        } else if (event.key === "Enter") {
            event.preventDefault();
            go(rows[active]);
        }
    }

    const searching = open && !loaded && !failed;
    const textsPending = !!loaded && loaded.chunks.size < loaded.manifest.chunks.length;

    return (
        <>
            <SearchTrigger
                label={words.search}
                hint={hint}
                title={`${words.search} (${hint}, /)`}
                aria-keyshortcuts="Control+K Meta+K /"
                onClick={() => setOpen(true)}
                className={className}
            />
            <SearchPalette
                open={open}
                onOpenChange={onOpenChange}
                title={words.open}
                query={query}
                onQueryChange={setQuery}
                onFieldKeyDown={onFieldKeyDown}
                placeholder={words.search}
                fieldProps={{ enterKeyHint: "go" }}
                activeId={rows[active] ? rowId(active) : undefined}
                listId="docs-search-results"
                listLabel={words.results}
                listRef={listRef}
                trail={
                    searching || (trimmed && textsPending) ? (
                        <Loader2
                            className="size-4 shrink-0 animate-spin text-muted-foreground"
                            aria-hidden="true"
                        />
                    ) : null
                }
                footer={
                    <>
                        <span className="hidden sm:inline">{words.hintMove}</span>
                        <span>{words.hintClose}</span>
                    </>
                }
            >
                {failed ? (
                    <p className="px-2 py-10 text-center text-sm text-danger" role="status">
                        {words.failed}
                    </p>
                ) : rows.length === 0 ? (
                    <p
                        className="px-2 py-10 text-center text-sm text-muted-foreground"
                        role="status"
                    >
                        {!trimmed ? words.emptyRecent : searching ? words.loading : words.empty}
                    </p>
                ) : (
                    groups.map((group) => (
                        <SearchGroup
                            key={`${group.label}-${group.rows[0]?.position}`}
                            label={group.label}
                            action={
                                !trimmed ? (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            writeRecent(locale, []);
                                            setRecent([]);
                                        }}
                                        className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                                    >
                                        {words.clear}
                                    </button>
                                ) : null
                            }
                        >
                            {group.rows.map(({ row, position }) => (
                                <SearchOption
                                    key={row.id}
                                    id={rowId(position)}
                                    selected={position === active}
                                    label={
                                        row.kind === "recent" ? row.entry.title : row.record.title
                                    }
                                    onSelect={() => go(row)}
                                    onHover={() => setActive(position)}
                                >
                                    {row.kind === "recent" ? (
                                        <>
                                            <Clock
                                                className="size-4 shrink-0 text-muted-foreground"
                                                aria-hidden="true"
                                            />
                                            <span
                                                className="min-w-0 flex-1 truncate text-sm"
                                                title={row.entry.title}
                                            >
                                                {row.entry.title}
                                            </span>
                                            <span className="hidden max-w-[40%] shrink-0 truncate text-xs text-muted-foreground sm:block">
                                                {row.entry.page}
                                            </span>
                                            <button
                                                type="button"
                                                title={words.forget}
                                                aria-label={words.forgetNamed.replace(
                                                    "{label}",
                                                    row.entry.title
                                                )}
                                                onClick={(event) => {
                                                    // The row underneath opens what it names; this only forgets it.
                                                    event.stopPropagation();
                                                    forget(row.entry);
                                                }}
                                                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                                            >
                                                <X className="size-3.5" aria-hidden="true" />
                                            </button>
                                        </>
                                    ) : (
                                        <>
                                            {row.record.href.includes("#") ? (
                                                <Hash
                                                    className="size-4 shrink-0 text-muted-foreground"
                                                    aria-hidden="true"
                                                />
                                            ) : (
                                                <FileText
                                                    className="size-4 shrink-0 text-muted-foreground"
                                                    aria-hidden="true"
                                                />
                                            )}
                                            <span className="min-w-0 flex-1">
                                                <span
                                                    className="block truncate text-sm"
                                                    title={row.record.title}
                                                >
                                                    <SearchHighlight
                                                        text={row.record.title}
                                                        terms={terms}
                                                    />
                                                </span>
                                                {row.record.text ? (
                                                    <span className="line-clamp-2 text-xs text-muted-foreground">
                                                        <SearchHighlight
                                                            text={snippet(row.record.text, terms)}
                                                            terms={terms}
                                                        />
                                                    </span>
                                                ) : null}
                                            </span>
                                            {position === active ? (
                                                <CornerDownLeft
                                                    className="size-3.5 shrink-0 text-muted-foreground"
                                                    aria-hidden="true"
                                                />
                                            ) : null}
                                        </>
                                    )}
                                </SearchOption>
                            ))}
                        </SearchGroup>
                    ))
                )}
            </SearchPalette>
        </>
    );
}
