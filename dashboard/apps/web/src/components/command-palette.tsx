"use client";

/**
 * The global search: a header field, Ctrl/Cmd+K from anywhere, and a centered
 * panel that finds any page of the dashboard plus the things the user owns.
 *
 * Two halves, and the split is what keeps it cheap. Pages and the resource index
 * - deploy projects and services, servers, runner pools, installed apps - are
 * known up front and matched here with fuse.js, so a typo still lands and typing
 * costs nothing. Tasks, pages, notes and people are too many to hold and too
 * live to cache, so they are searched in the database, one scope at a time, and
 * only behind a command: "/tasks", "/servers lirio-0", "@ana". Typing a name on
 * its own never starts four searches nobody asked for.
 *
 * What was searched before is kept in this browser and on the account. The local
 * copy is what the panel opens with - instantly, on the first frame - and the
 * account's copy arrives a moment later and merges, so the list follows somebody
 * to another machine without the panel ever waiting for it.
 */

import Fuse from "fuse.js";
import * as core from "@polaris/core";
import { useRouter } from "next/navigation";
import { Loader2, Search, X } from "lucide-react";
import * as recentStore from "@/lib/search/recent";
import type { SearchHit } from "@/lib/search/lookup-service";
import { commandSuggestions, detectCommand } from "@/lib/search/parse";
import { Dialog, DialogContent, DialogTitle, Input, cn } from "@polaris/ui";
import { searchScope, type SearchScopeDefinition } from "@/lib/search/scopes";
import { CommandRow, EntryRow, HitRow, HitSkeleton, RecentRow } from "@/components/search-rows";
import {
    navigationEntries,
    resourceEntries,
    type CommandEntry,
    type SearchResource
} from "@/lib/search/entries";
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent
} from "react";
import {
    clearSearchHistoryAction,
    forgetSearchAction,
    listRecentSearchesAction,
    recordSearchAction
} from "@/app/(app)/search-actions";

/** How long a fetched resource index is reused before it is asked for again. */
const INDEX_TTL_MS = 60_000;
/** How long one scoped search is reused. Long enough to cover a backspace and a
 *  retype of the same word, short enough that something renamed in another tab
 *  is not remembered wrong for long. */
const LOOKUP_TTL_MS = 30_000;
/** The pause that turns typing into a query. */
const LOOKUP_DEBOUNCE_MS = 220;
/** Matches shown at once. Past this the query is the thing to narrow, not the list. */
const MAX_RESULTS = 40;
/** Earlier searches offered alongside live matches, so they lead without burying. */
const MAX_RECENT_SUGGESTIONS = 3;

// Kept outside the component so opening the palette a second time paints from
// what the first open already loaded.
let indexCache: { at: number; resources: SearchResource[] } | null = null;
const lookupCache = new Map<string, { at: number; hits: SearchHit[] }>();

/** One line of the panel. Everything the arrow keys move through is one of these. */
type Row =
    | { kind: "command"; id: string; group: string; scope: SearchScopeDefinition }
    | { kind: "entry"; id: string; group: string; entry: CommandEntry }
    | { kind: "hit"; id: string; group: string; hit: SearchHit }
    | { kind: "recent"; id: string; group: string; entry: core.RecentSearch };

interface Group {
    label: string;
    /** Each row with its position in the flat list, which is what the arrow keys
     *  move through - so the headings never disturb the ranking. */
    rows: Array<{ row: Row; position: number }>;
}

function groupRows(rows: readonly Row[]): Group[] {
    const groups: Group[] = [];
    rows.forEach((row, position) => {
        const last = groups[groups.length - 1];
        if (last?.label === row.group) last.rows.push({ row, position });
        else groups.push({ label: row.group, rows: [{ row, position }] });
    });
    return groups;
}

export function CommandPalette({ isAdmin = false, appIds }: { isAdmin?: boolean; appIds: string[] }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [scope, setScope] = useState<SearchScopeDefinition | null>(null);
    const [active, setActive] = useState(0);
    const [resources, setResources] = useState<SearchResource[]>(indexCache?.resources ?? []);
    const [loading, setLoading] = useState(false);
    const [hits, setHits] = useState<SearchHit[]>([]);
    const [searching, setSearching] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const [recent, setRecent] = useState<core.RecentSearch[]>([]);
    const [hint, setHint] = useState("Ctrl K");
    const listRef = useRef<HTMLDivElement>(null);
    const fieldRef = useRef<HTMLInputElement>(null);
    // Set when a result is opened, so closing does not also file the query that
    // found it - the destination is the better memory of the two.
    const openedRef = useRef(false);

    // The modifier is whatever the user's keyboard actually uses, but only the
    // browser knows - so the label is corrected after mount rather than guessed
    // during render, which would not survive hydration.
    useEffect(() => {
        if (/Mac|iPhone|iPad|iPod/.test(navigator.userAgent)) setHint("Cmd K");
    }, []);

    useEffect(() => {
        function onKeyDown(event: KeyboardEvent) {
            if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey) || event.altKey) return;
            // Browsers put Ctrl+K on the address bar; the dashboard claims it here.
            event.preventDefault();
            setOpen((value) => !value);
        }
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    const loadResources = useCallback(() => {
        if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) {
            setResources(indexCache.resources);
            return;
        }
        setLoading(true);
        void fetch("/api/search", { cache: "no-store" })
            .then((response) => (response.ok ? response.json() : { resources: [] }))
            .then((body: { resources?: SearchResource[] }) => {
                const list = body.resources ?? [];
                indexCache = { at: Date.now(), resources: list };
                setResources(list);
            })
            .catch(() => undefined)
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        if (!open) return;
        setQuery("");
        setScope(null);
        setActive(0);
        setHits([]);
        setFailure(null);
        openedRef.current = false;
        loadResources();
        // What this browser remembers paints now; what the account remembers is
        // merged into it when it arrives.
        setRecent(recentStore.readRecentSearches());
        void listRecentSearchesAction()
            .then((body) => setRecent(recentStore.mergeIntoStore(body.recent)))
            .catch(() => undefined);
    }, [open, loadResources]);

    const trimmed = query.trim();

    function remember(input: core.RecentSearchInput): void {
        setRecent(recentStore.rememberSearch(input));
        // The account's copy is best-effort: the browser already has it.
        void recordSearchAction(input).catch(() => undefined);
    }

    function forget(entry: core.RecentSearch): void {
        const key = core.recentSearchKey(entry);
        setRecent(recentStore.forgetRecentSearch(key));
        void forgetSearchAction({ key }).catch(() => undefined);
    }

    function forgetAll(): void {
        recentStore.clearRecentSearches();
        setRecent([]);
        void clearSearchHistoryAction().catch(() => undefined);
    }

    /**
     * A scoped search that found something is worth remembering as a search, but
     * only when it was not the way to something better: a result that was opened
     * is remembered instead, and remembering both would say the same thing twice.
     */
    function onOpenChange(next: boolean): void {
        if (!next && scope && trimmed.length > 1 && !openedRef.current && hits.length > 0) {
            remember({ kind: "query", scope: scope.id, term: trimmed, label: trimmed, href: null });
        }
        setOpen(next);
    }

    /** Typing, with the command taken off the front once it is complete. */
    function onFieldChange(value: string): void {
        if (!scope) {
            const command = detectCommand(value);
            if (command) {
                setScope(command.scope);
                setQuery(command.term);
                setActive(0);
                return;
            }
        }
        setQuery(value);
        setActive(0);
    }

    function clearScope(): void {
        setScope(null);
        setHits([]);
        setFailure(null);
        setActive(0);
        fieldRef.current?.focus();
    }

    // One scoped search per pause, dropped if the field moves on before it lands.
    useEffect(() => {
        if (!open || !scope || scope.resourceKind) return;
        const term = trimmed;
        const key = `${scope.id}:${term.toLowerCase()}`;
        const cached = lookupCache.get(key);
        if (cached && Date.now() - cached.at < LOOKUP_TTL_MS) {
            setHits(cached.hits);
            setFailure(null);
            setSearching(false);
            return;
        }

        const controller = new AbortController();
        setSearching(true);
        const timer = setTimeout(
            () => {
                void fetch(`/api/search/lookup?scope=${scope.id}&q=${encodeURIComponent(term)}`, {
                    cache: "no-store",
                    signal: controller.signal
                })
                    .then(async (response) => {
                        const body: { hits?: SearchHit[]; error?: string } = await response.json();
                        if (!response.ok) throw new Error(body.error ?? "That search could not be run");
                        const found = body.hits ?? [];
                        lookupCache.set(key, { at: Date.now(), hits: found });
                        setHits(found);
                        setFailure(null);
                    })
                    .catch((caught: unknown) => {
                        // An aborted request is the next keystroke, not a failure.
                        if (caught instanceof DOMException && caught.name === "AbortError") return;
                        console.error(caught);
                        setHits([]);
                        setFailure("That search could not be run. Try again in a moment.");
                    })
                    .finally(() => {
                        if (!controller.signal.aborted) setSearching(false);
                    });
            },
            // Opening a command asks straight away: it is one deliberate query,
            // and waiting on it would only make the panel feel slow.
            term ? LOOKUP_DEBOUNCE_MS : 0
        );

        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [open, scope, trimmed]);

    // Keyed on the joined ids: the array is rebuilt on every render of the layout
    // above, so identity alone would rebuild the index for nothing.
    const appKey = appIds.join(",");
    const navigation = useMemo(() => navigationEntries(isAdmin, appKey ? appKey.split(",") : []), [isAdmin, appKey]);

    /** What fuse matches against: everything, or one scope's slice of the index. */
    const pool = useMemo(() => {
        if (!scope) return [...navigation, ...resourceEntries(resources)];
        if (!scope.resourceKind) return [];
        return resourceEntries(resources.filter((resource) => resource.kind === scope.resourceKind));
    }, [scope, navigation, resources]);

    const fuse = useMemo(
        () =>
            new Fuse(pool, {
                threshold: 0.4,
                ignoreLocation: true,
                keys: [
                    { name: "label", weight: 3 },
                    { name: "keywords", weight: 2 },
                    { name: "context", weight: 1 },
                    { name: "group", weight: 1 }
                ]
            }),
        [pool]
    );

    const suggestions = useMemo(() => (scope ? [] : commandSuggestions(query)), [scope, query]);

    /** Earlier searches, narrowed to the command in hand and to what is typed. */
    const recentRows = useMemo(() => {
        const matching = recent.filter((entry) => {
            if (scope && entry.scope !== scope.id) return false;
            if (!trimmed) return true;
            return entry.label.toLowerCase().includes(trimmed.toLowerCase());
        });
        return trimmed ? matching.slice(0, MAX_RECENT_SUGGESTIONS) : matching;
    }, [recent, scope, trimmed]);

    const rows = useMemo(() => {
        const commands: Row[] = suggestions.map((definition) => ({
            kind: "command",
            id: `command:${definition.id}`,
            group: "Commands",
            scope: definition
        }));

        // Halfway through writing a command, the commands are the answer: fuzzy
        // matches for the slash and the letters typed so far are only noise.
        const writingCommand = !scope && query.trimStart().startsWith("/");
        const found: Row[] = [];
        if (!writingCommand) {
            if (scope && !scope.resourceKind) {
                for (const hit of hits) {
                    found.push({ kind: "hit", id: `hit:${hit.scope}:${hit.id}`, group: scope.label, hit });
                }
            } else {
                // With nothing typed and no command, the panel is a map of the
                // dashboard rather than a ranking, so the pages are listed as
                // their apps order them.
                const matches = trimmed ? fuse.search(trimmed, { limit: MAX_RESULTS }).map((match) => match.item) : pool;
                const shown = trimmed || scope ? matches : navigation;
                for (const entry of shown.slice(0, MAX_RESULTS)) {
                    found.push({
                        kind: "entry",
                        id: `entry:${entry.id}`,
                        group: scope ? scope.label : entry.group,
                        entry
                    });
                }
            }
        }

        // A search that already found the thing does not also need to remember
        // it: the live row is the same row, with the state it has now.
        const live = new Set(
            found.map((row) => (row.kind === "hit" ? row.hit.href : row.kind === "entry" ? row.entry.href : ""))
        );
        const remembered: Row[] = recentRows
            .filter((entry) => !entry.href || !live.has(entry.href))
            .map((entry) => ({ kind: "recent", id: `recent:${core.recentSearchKey(entry)}`, group: "Recent", entry }));

        return [...remembered, ...commands, ...found];
    }, [recentRows, suggestions, scope, hits, trimmed, query, fuse, pool, navigation]);

    const groups = useMemo(() => groupRows(rows), [rows]);

    // A shorter result list must not leave the highlight past its end.
    useEffect(() => {
        setActive((current) => (current < rows.length ? current : 0));
    }, [rows.length]);

    useEffect(() => {
        listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
    }, [active, rows]);

    function go(row: Row | undefined): void {
        if (!row) return;
        if (row.kind === "command") {
            setScope(row.scope);
            setQuery("");
            setActive(0);
            fieldRef.current?.focus();
            return;
        }

        if (row.kind === "recent" && !row.entry.href) {
            // A remembered query is put back in the field and run again.
            setScope(row.entry.scope ? searchScope(row.entry.scope) : null);
            setQuery(row.entry.term);
            setActive(0);
            fieldRef.current?.focus();
            return;
        }

        const target =
            row.kind === "hit"
                ? { label: row.hit.label, href: row.hit.href, scope: row.hit.scope as core.SearchScope | null }
                : row.kind === "recent"
                  ? { label: row.entry.label, href: row.entry.href!, scope: row.entry.scope }
                  : { label: row.entry.label, href: row.entry.href, scope: scope?.id ?? null };

        openedRef.current = true;
        remember({ kind: "result", scope: target.scope, term: trimmed, label: target.label, href: target.href });
        // Navigate before closing. Closing hands focus back to the trigger, and
        // a push issued in the same tick as that hand-off is dropped when the
        // panel was dismissed from the keyboard - the row opens on a click and
        // does nothing on Enter, which is the sort of bug nobody reports.
        router.push(target.href);
        setOpen(false);
    }

    function onFieldKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
        if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((current) => (rows.length === 0 ? 0 : (current + 1) % rows.length));
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((current) => (rows.length === 0 ? 0 : (current - 1 + rows.length) % rows.length));
        } else if (event.key === "Home") {
            event.preventDefault();
            setActive(0);
        } else if (event.key === "End") {
            event.preventDefault();
            setActive(Math.max(0, rows.length - 1));
        } else if (event.key === "Enter") {
            event.preventDefault();
            go(rows[active]);
        } else if (event.key === "Tab" && suggestions.length > 0) {
            // The command being spelled out is one key away from being taken.
            event.preventDefault();
            setScope(suggestions[0]!);
            setQuery("");
            setActive(0);
        } else if (event.key === "Backspace" && scope && !query) {
            // Backing out of a command is backspace, where it was typed.
            event.preventDefault();
            clearScope();
        }
    }

    const ScopeIcon = scope?.icon;

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                title={`Search (${hint})`}
                aria-label="Search Polaris"
                aria-keyshortcuts="Control+K Meta+K"
                // Below lg the header is already carrying the switcher and a page's
                // own controls, so the field collapses to its icon rather than
                // squeezing them.
                className="flex h-9 w-9 items-center justify-center rounded-md border border-input bg-surface text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground lg:w-full lg:max-w-sm lg:justify-start lg:gap-2 lg:px-3"
            >
                <Search className="size-4 shrink-0" aria-hidden="true" />
                <span className="hidden flex-1 truncate text-left text-sm lg:block">Search</span>
                <kbd className="hidden shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] leading-none lg:block">
                    {hint}
                </kbd>
            </button>

            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent showClose={false} className="max-w-xl overflow-hidden p-0">
                    <DialogTitle className="sr-only">Search Polaris</DialogTitle>
                    <div className="flex items-center gap-2 border-b border-border px-3">
                        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        {scope && ScopeIcon ? (
                            <span className="flex shrink-0 items-center gap-1 rounded-md bg-muted py-1 pl-2 pr-1 text-xs font-medium">
                                <ScopeIcon className="size-3.5" aria-hidden="true" />
                                {scope.label}
                                <button
                                    type="button"
                                    onClick={clearScope}
                                    title="Search everything again"
                                    aria-label={`Stop searching ${scope.label}`}
                                    className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                                >
                                    <X className="size-3" aria-hidden="true" />
                                </button>
                            </span>
                        ) : null}
                        <Input
                            autoFocus
                            ref={fieldRef}
                            type="search"
                            value={query}
                            onChange={(event) => onFieldChange(event.target.value)}
                            onKeyDown={onFieldKeyDown}
                            placeholder={scope ? scope.placeholder : "Search, or type / for commands"}
                            enterKeyHint="go"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            aria-label={scope ? scope.placeholder : "Search Polaris"}
                            aria-controls="polaris-search-results"
                            className="h-12 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                        />
                        {loading || searching ? (
                            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
                        ) : null}
                    </div>

                    <div
                        ref={listRef}
                        id="polaris-search-results"
                        role="listbox"
                        aria-label="Search results"
                        className="max-h-[min(60vh,26rem)] overflow-y-auto overscroll-contain p-2"
                    >
                        {failure ? (
                            <p className="px-2 py-10 text-center text-sm text-danger">{failure}</p>
                        ) : rows.length === 0 && searching ? (
                            <HitSkeleton />
                        ) : rows.length === 0 ? (
                            <p className="px-2 py-10 text-center text-sm text-muted-foreground">
                                {scope
                                    ? trimmed
                                        ? `No ${scope.label.toLowerCase()} match "${trimmed}".`
                                        : `Nothing in ${scope.label.toLowerCase()} yet.`
                                    : `Nothing matches "${trimmed}".`}
                            </p>
                        ) : (
                            groups.map((group) => (
                                <div
                                    key={`${group.label}-${group.rows[0]?.position}`}
                                    role="group"
                                    aria-label={group.label}
                                    className="mb-1 last:mb-0"
                                >
                                    <div className="flex items-center justify-between gap-2 px-2 py-1">
                                        {/* The name is on the group, so announcing the
                                            heading again would only repeat it. */}
                                        <p
                                            aria-hidden="true"
                                            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                                        >
                                            {group.label}
                                        </p>
                                        {group.label === "Recent" && !trimmed ? (
                                            <button
                                                type="button"
                                                onClick={forgetAll}
                                                className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                                            >
                                                Clear
                                            </button>
                                        ) : null}
                                    </div>
                                    {group.rows.map(({ row, position }) => {
                                        const selected = position === active;
                                        const select = () => go(row);
                                        const hover = () => setActive(position);
                                        if (row.kind === "command") {
                                            return (
                                                <CommandRow
                                                    key={row.id}
                                                    scope={row.scope}
                                                    selected={selected}
                                                    onSelect={select}
                                                    onHover={hover}
                                                />
                                            );
                                        }
                                        if (row.kind === "hit") {
                                            return (
                                                <HitRow
                                                    key={row.id}
                                                    hit={row.hit}
                                                    selected={selected}
                                                    onSelect={select}
                                                    onHover={hover}
                                                />
                                            );
                                        }
                                        if (row.kind === "recent") {
                                            return (
                                                <RecentRow
                                                    key={row.id}
                                                    entry={row.entry}
                                                    scopeLabel={
                                                        row.entry.scope ? searchScope(row.entry.scope).label : null
                                                    }
                                                    selected={selected}
                                                    onSelect={select}
                                                    onHover={hover}
                                                    onForget={() => forget(row.entry)}
                                                />
                                            );
                                        }
                                        return (
                                            <EntryRow
                                                key={row.id}
                                                entry={row.entry}
                                                selected={selected}
                                                onSelect={select}
                                                onHover={hover}
                                            />
                                        );
                                    })}
                                </div>
                            ))
                        )}
                        {rows.length > 0 && searching ? <HitSkeleton /> : null}
                    </div>

                    <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs text-muted-foreground">
                        <span className={cn(scope && "hidden sm:inline")}>Up and down to move, Enter to open</span>
                        <span>{scope ? "Backspace clears the command" : "Type / for commands, @ for people"}</span>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}
