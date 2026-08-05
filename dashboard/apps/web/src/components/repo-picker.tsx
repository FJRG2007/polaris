"use client";

/**
 * Finding a GitHub repository.
 *
 * One field takes everything: a name to search for, `owner/repo`, a URL copied
 * from the browser, an SSH remote, or - where the caller allows it - a git URL
 * somewhere other than GitHub. Repositories the connected account can already see
 * are matched locally as the operator types (fuzzy, so a typo still lands);
 * anything else is looked up on GitHub once the typing settles, which is what
 * makes a public repository nobody here owns reachable, including with GitHub not
 * connected at all.
 *
 * The two reads are props rather than imports because each app gates them on its
 * own permission - Deploy on `deploy.manage`, Agents on `agents.manage`, Runners
 * on its own - and a picker that reached for one of them would hand every screen
 * the widest gate of the three.
 */

import Fuse from "fuse.js";
import { Button, Input } from "@polaris/ui";
import { GitHubMark } from "@/components/brand-icons";
import { externalGitUrl } from "@/lib/repo-reference";
import { Globe, Loader2, Lock, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** A repository, as every picker row renders one. */
export interface PickerRepo {
    fullName: string;
    defaultBranch: string;
    private: boolean;
}

/** What the connected account can reach. */
export interface RepoListResult {
    connected: boolean;
    repos: PickerRepo[];
}

/** How long the typing has to settle before GitHub is asked. Repositories already
 *  loaded are matched on every keystroke regardless; only the call waits. */
const SEARCH_DEBOUNCE_MS = 350;

/**
 * Session caches, one entry per caller.
 *
 * Keyed rather than shared: the three screens read the list through different
 * permission gates, and one cache would let a screen render a list its own gate
 * would not have returned. Reopening the same dialog is instant; the refresh
 * button re-asks GitHub.
 */
const listCache = new Map<string, RepoListResult>();
const searchCache = new Map<string, PickerRepo[]>();

export interface RepoPickerProps {
    /** Names the session cache. One per screen. */
    cacheKey: string;
    /** The connected account's own repositories. */
    list: () => Promise<RepoListResult>;
    /** Anything the loaded list does not hold, asked of GitHub. */
    search: (query: string) => Promise<{ repos: PickerRepo[] }>;
    onPick: (repo: PickerRepo) => void;
    /** Offered when the input is a clonable git URL outside GitHub. Without this
     *  the picker only ever answers with a GitHub repository. */
    onPickUrl?: (url: string) => void;
    /** Repositories already chosen, so the list can mark them. */
    selected?: readonly string[];
    placeholder?: string;
    autoFocus?: boolean;
    /** Rows visible before the list scrolls. */
    maxHeightClass?: string;
}

export function RepoPicker({
    cacheKey,
    list,
    search,
    onPick,
    onPickUrl,
    selected = [],
    placeholder = "Search repositories, or paste a repo URL",
    autoFocus = false,
    maxHeightClass = "max-h-56"
}: RepoPickerProps) {
    const cached = listCache.get(cacheKey);
    const [loading, setLoading] = useState(cached === undefined);
    const [connected, setConnected] = useState(cached?.connected ?? false);
    const [repos, setRepos] = useState<PickerRepo[]>(cached?.repos ?? []);
    const [query, setQuery] = useState("");
    const [found, setFound] = useState<PickerRepo[]>([]);
    const [searching, setSearching] = useState(false);

    // The action props are recreated on every render of the caller, so they are
    // read through a ref: depending on them would re-run the load on every
    // keystroke of an unrelated field.
    const actions = useRef({ list, search });
    actions.current = { list, search };

    const load = useCallback(
        (force: boolean) => {
            const stored = listCache.get(cacheKey);
            if (!force && stored !== undefined) {
                setRepos(stored.repos);
                setConnected(stored.connected);
                setLoading(false);
                return;
            }
            setLoading(true);
            void actions.current
                .list()
                .then((result) => {
                    listCache.set(cacheKey, result);
                    setRepos(result.repos);
                    setConnected(result.connected);
                })
                .catch(() => undefined)
                .finally(() => setLoading(false));
        },
        [cacheKey]
    );

    useEffect(() => {
        load(false);
    }, [load]);

    const trimmed = query.trim();
    const external = onPickUrl ? externalGitUrl(trimmed) : null;

    const fuse = useMemo(
        () => new Fuse(repos, { keys: ["fullName"], threshold: 0.4, ignoreLocation: true }),
        [repos]
    );
    const mine = trimmed ? fuse.search(trimmed, { limit: 20 }).map((match) => match.item) : repos;

    // Ask GitHub for whatever the loaded list does not already hold. A URL that is
    // not GitHub's is nothing to search for - it is the answer already.
    useEffect(() => {
        const term = query.trim();
        if (term.length < 2 || (onPickUrl && externalGitUrl(term))) {
            setFound([]);
            setSearching(false);
            return;
        }
        const stored = searchCache.get(term);
        if (stored) {
            setFound(stored);
            setSearching(false);
            return;
        }
        setSearching(true);
        let live = true;
        const timer = setTimeout(() => {
            void actions.current
                .search(term)
                .then((result) => {
                    searchCache.set(term, result.repos);
                    if (live) setFound(result.repos);
                })
                .catch(() => undefined)
                .finally(() => {
                    if (live) setSearching(false);
                });
        }, SEARCH_DEBOUNCE_MS);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [query, onPickUrl]);

    const owned = new Set(mine.map((repo) => repo.fullName));
    const discovered = found.filter((repo) => !owned.has(repo.fullName));
    const empty = !external && mine.length === 0 && discovered.length === 0;

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
                <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        autoFocus={autoFocus}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={placeholder}
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        inputMode="url"
                        aria-label="Repository"
                        className="pl-8 pr-8"
                    />
                    {searching && (
                        <Loader2 className="absolute right-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                    )}
                </div>
                {connected && (
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        title="Refresh repositories"
                        aria-label="Refresh repositories"
                        disabled={loading}
                        onClick={() => load(true)}
                    >
                        <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
                    </Button>
                )}
            </div>

            <div className={`${maxHeightClass} overflow-auto overscroll-contain rounded-md border border-border/60`}>
                {external && onPickUrl ? (
                    <button
                        type="button"
                        onClick={() => onPickUrl(external)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                    >
                        <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate" title={external}>{external}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">Use this URL</span>
                    </button>
                ) : loading && repos.length === 0 ? (
                    <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" /> Loading repositories...
                    </div>
                ) : empty ? (
                    <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                        {searching
                            ? "Searching GitHub..."
                            : trimmed
                              ? "No repository matches."
                              : "Type a repository name, or paste its URL."}
                    </p>
                ) : (
                    <>
                        {mine.length > 0 && (
                            <RepoGroup
                                label={connected ? "Your repositories" : "Repositories"}
                                repos={mine}
                                selected={selected}
                                onPick={onPick}
                            />
                        )}
                        {discovered.length > 0 && (
                            <RepoGroup
                                label="Public on GitHub"
                                repos={discovered}
                                selected={selected}
                                onPick={onPick}
                            />
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

/** One labelled block of repository rows. Both sources render the same row, so a
 *  repository looks the same whether it came from the account or from a search. */
function RepoGroup({
    label,
    repos,
    selected,
    onPick
}: {
    label: string;
    repos: PickerRepo[];
    selected: readonly string[];
    onPick: (repo: PickerRepo) => void;
}) {
    return (
        <div>
            <p className="sticky top-0 bg-surface/95 px-3 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
                {label}
            </p>
            {repos.map((repo) => (
                <button
                    key={repo.fullName}
                    type="button"
                    onClick={() => onPick(repo)}
                    aria-pressed={selected.includes(repo.fullName)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted ${
                        selected.includes(repo.fullName) ? "bg-muted/60" : ""
                    }`}
                >
                    <GitHubMark className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate" title={repo.fullName}>{repo.fullName}</span>
                    <span className="flex shrink-0 items-center gap-2 pl-2 text-xs text-muted-foreground">
                        {repo.private && <Lock className="size-3.5" />}
                        {repo.defaultBranch}
                    </span>
                </button>
            ))}
        </div>
    );
}

/** Forget a cached list, so the next picker that opens re-reads it. Called after
 *  something that changes what the account can see, such as connecting an
 *  account or installing the App somewhere new. */
export function forgetPickerCache(cacheKey: string): void {
    listCache.delete(cacheKey);
}
