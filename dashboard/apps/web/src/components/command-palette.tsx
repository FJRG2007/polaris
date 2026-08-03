"use client";

/**
 * The global search: a header field, Ctrl/Cmd+K from anywhere, and a centered
 * panel that finds any page of the dashboard plus the things the user owns -
 * deploy projects and services, servers, runner pools, installed apps.
 *
 * Matching is fuzzy (fuse.js), so a typo or a half-remembered name still lands.
 * Pages are known up front from the app registries; the resource half is fetched
 * once on first open and kept for a short while, because it changes far slower
 * than a search box is opened and a stale name costs nothing - the page it opens
 * is authoritative.
 */

import Fuse from "fuse.js";
import { useRouter } from "next/navigation";
import { Loader2, Search } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, Input, cn } from "@polaris/ui";
import {
    navigationEntries,
    resourceEntries,
    type CommandEntry,
    type SearchResource
} from "@/lib/search-index";
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent
} from "react";

/** How long a fetched resource index is reused before it is asked for again. */
const INDEX_TTL_MS = 60_000;
/** Matches shown at once. Past this the query is the thing to narrow, not the list. */
const MAX_RESULTS = 40;

// Kept outside the component so opening the palette a second time paints from
// what the first open already loaded.
let indexCache: { at: number; resources: SearchResource[] } | null = null;

interface Group {
    label: string;
    /** Each match with its position in the flat result list, which is what the
     *  arrow keys move through - so the headings never disturb the ranking. */
    entries: Array<{ entry: CommandEntry; position: number }>;
}

function groupEntries(entries: CommandEntry[]): Group[] {
    const groups: Group[] = [];
    entries.forEach((entry, position) => {
        const last = groups[groups.length - 1];
        if (last?.label === entry.group) last.entries.push({ entry, position });
        else groups.push({ label: entry.group, entries: [{ entry, position }] });
    });
    return groups;
}

export function CommandPalette({ isAdmin = false, appIds }: { isAdmin?: boolean; appIds: string[] }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    const [resources, setResources] = useState<SearchResource[]>(indexCache?.resources ?? []);
    const [loading, setLoading] = useState(false);
    const [hint, setHint] = useState("Ctrl K");
    const listRef = useRef<HTMLDivElement>(null);

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
        setActive(0);
        loadResources();
    }, [open, loadResources]);

    // Keyed on the joined ids: the array is rebuilt on every render of the layout
    // above, so identity alone would rebuild the index for nothing.
    const appKey = appIds.join(",");
    const navigation = useMemo(() => navigationEntries(isAdmin, appKey ? appKey.split(",") : []), [isAdmin, appKey]);
    const entries = useMemo(
        () => [...navigation, ...resourceEntries(resources)],
        [navigation, resources]
    );
    const fuse = useMemo(
        () =>
            new Fuse(entries, {
                threshold: 0.4,
                ignoreLocation: true,
                keys: [
                    { name: "label", weight: 3 },
                    { name: "keywords", weight: 2 },
                    { name: "context", weight: 1 },
                    { name: "group", weight: 1 }
                ]
            }),
        [entries]
    );

    const trimmed = query.trim();
    const results = useMemo(() => {
        // With nothing typed the panel is a map of the dashboard rather than a
        // ranking, so the pages are listed as their apps order them.
        if (!trimmed) return navigation;
        return fuse.search(trimmed, { limit: MAX_RESULTS }).map((match) => match.item);
    }, [trimmed, fuse, navigation]);

    const groups = useMemo(() => groupEntries(results), [results]);

    // A shorter result list must not leave the highlight past its end.
    useEffect(() => {
        setActive((current) => (current < results.length ? current : 0));
    }, [results.length]);

    useEffect(() => {
        listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
    }, [active, results]);

    function go(entry: CommandEntry | undefined) {
        if (!entry) return;
        setOpen(false);
        router.push(entry.href);
    }

    function onFieldKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
        if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((current) => (results.length === 0 ? 0 : (current + 1) % results.length));
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((current) => (results.length === 0 ? 0 : (current - 1 + results.length) % results.length));
        } else if (event.key === "Home") {
            event.preventDefault();
            setActive(0);
        } else if (event.key === "End") {
            event.preventDefault();
            setActive(Math.max(0, results.length - 1));
        } else if (event.key === "Enter") {
            event.preventDefault();
            go(results[active]);
        }
    }

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

            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent showClose={false} className="max-w-xl overflow-hidden p-0">
                    <DialogTitle className="sr-only">Search Polaris</DialogTitle>
                    <div className="flex items-center gap-2 border-b border-border px-3">
                        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <Input
                            autoFocus
                            type="search"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            onKeyDown={onFieldKeyDown}
                            placeholder="Search pages, projects, services, servers..."
                            enterKeyHint="go"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            aria-label="Search Polaris"
                            aria-controls="polaris-search-results"
                            className="h-12 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                        />
                        {loading ? (
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
                        {results.length === 0 ? (
                            <p className="px-2 py-10 text-center text-sm text-muted-foreground">
                                Nothing matches {`"${trimmed}"`}.
                            </p>
                        ) : (
                            groups.map((group) => (
                                <div
                                    key={`${group.label}-${group.entries[0]?.position}`}
                                    role="group"
                                    aria-label={group.label}
                                    className="mb-1 last:mb-0"
                                >
                                    {/* The name is on the group, so announcing the
                                        heading again would only repeat it. */}
                                    <p
                                        aria-hidden="true"
                                        className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
                                    >
                                        {group.label}
                                    </p>
                                    {group.entries.map(({ entry, position }) => {
                                        const Icon = entry.icon;
                                        const selected = position === active;
                                        return (
                                            <button
                                                key={entry.id}
                                                type="button"
                                                role="option"
                                                aria-selected={selected}
                                                data-active={selected}
                                                onMouseMove={() => setActive(position)}
                                                onClick={() => go(entry)}
                                                className={cn(
                                                    "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors",
                                                    selected ? "bg-muted" : "hover:bg-muted/60"
                                                )}
                                            >
                                                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate text-sm">{entry.label}</span>
                                                    {entry.context ? (
                                                        <span className="block truncate text-xs text-muted-foreground">
                                                            {entry.context}
                                                        </span>
                                                    ) : null}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            ))
                        )}
                    </div>

                    <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs text-muted-foreground">
                        <span>Up and down to move, Enter to open</span>
                        <span>Esc to close</span>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}
