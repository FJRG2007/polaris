"use client";

/**
 * Where a Code task works, and who works on it.
 *
 * The repository and its branch are one chip under the composer. Its menu (a
 * portal with collision handling) searches the connected repositories, picks
 * an empty workspace, gives Polaris's GitHub App more repositories on GitHub -
 * with a refresh for when the person comes back - and opens the repository's
 * branches in a submenu.
 *
 * The agent is picked on the composer, in the model picker's place and look.
 */

import Link from "next/link";
import { settingsSection } from "@/lib/polar/settings-path";
import { AgentLogo } from "@/components/logos";
import type { PolarCodeChoices } from "@/lib/polar/code";
import type { AgentOption } from "@/lib/agents/agent-readiness";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useEffect, useState, type ReactNode } from "react";
import type { PolarCodeBranches } from "@/lib/polar/code";
import { readPoll } from "@/lib/poll-fetch";
import { MODEL_TRIGGER } from "@/components/polar/elements/model-selector";
import * as core from "@polaris/core";
import {
    Bot,
    Check,
    ChevronDown,
    ExternalLink,
    FolderGit2,
    CircleDot,
    GitBranch,
    Plus,
    RefreshCw,
    ShieldCheck,
    Sparkles,
    Wand2,
    X
} from "lucide-react";
import type { RepoIssue } from "@/lib/github-service";
import {
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
    MenuSearch,
    menuSearchMatches
} from "@polaris/ui";

/** The repository picker's "none": a workspace with nothing checked out. */
export const NO_REPO = "workspace";

/** The picker's row for Polar itself, answering on the chat's own models. */
export const POLAR_ENGINE = "polar";

/** The bar's row, drawn the same for a new task and a session. */
function BarRow({ fullPage, children }: { fullPage: boolean; children: ReactNode }) {
    return (
        <div className="shrink-0 border-b border-border">
            <div
                className={cn(
                    "flex h-9 min-w-0 items-center gap-2 text-xs text-muted-foreground",
                    fullPage ? "mx-auto w-full max-w-3xl px-4" : "px-3"
                )}
            >
                {children}
            </div>
        </div>
    );
}

/** "owner/repo" and the branch, each cut to the room there is. */
function Where({ repo, branch }: { repo: string; branch?: string }) {
    return (
        <>
            <FolderGit2 className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 truncate text-foreground" title={repo}>
                {repo}
            </span>
            {branch ? (
                <>
                    <GitBranch className="size-3.5 shrink-0" aria-hidden />
                    <span className="min-w-0 max-w-[40%] shrink-[2] truncate" title={branch}>
                        {branch}
                    </span>
                </>
            ) : null}
        </>
    );
}

/** A session's place, read-only: it was set when the session started. */
export function CodeSessionBar({
    fullPage,
    repo,
    branch,
    children
}: {
    fullPage: boolean;
    repo: string;
    branch: string;
    /** The session's state and its full page, at the end of the row. */
    children?: ReactNode;
}) {
    const t = useTranslations("polar");
    const name = repo || t("code.workspace");
    return (
        <BarRow fullPage={fullPage}>
            <span
                className="flex min-w-0 flex-1 items-center gap-1.5"
                title={branch ? `${name} - ${branch}` : name}
            >
                <Where repo={name} branch={branch} />
            </span>
            {children}
        </BarRow>
    );
}

/** Where the composer reads a page of repositories: searched, continued or by id. */
export const REPOS_ROUTE = "/api/polar/code/repos";

interface RepoEntry {
    id: string;
    name: string;
}
type RepoPage = { items: RepoEntry[]; next: string | null } | null;

/** One connected repository by id, or null when it is gone or not this person's. */
export async function readRepo(id: string): Promise<RepoEntry | null> {
    const page = await readPoll<RepoPage>(REPOS_ROUTE, { id });
    return page?.items[0] ?? null;
}

/**
 * The repositories the menu lists: with no search, the first page the choices
 * brought and any pages read after it; with one, the matches the server found.
 * Only what somebody scrolled to is ever in the browser.
 */
function useRepoList(choices: PolarCodeChoices | null, query: string) {
    const wanted = query.trim();
    const [pages, setPages] = useState<{
        key: string;
        items: RepoEntry[];
        next: string | null;
    } | null>(null);
    const [loading, setLoading] = useState(false);
    // A refresh brings a new first page, and the pages read after the old one go.
    useEffect(() => setPages(null), [choices]);
    useEffect(() => {
        if (!wanted) return;
        const controller = new AbortController();
        const timer = setTimeout(() => {
            setLoading(true);
            readPoll<RepoPage>(REPOS_ROUTE, { query: wanted }, controller.signal)
                .then((page) =>
                    setPages({ key: wanted, items: page?.items ?? [], next: page?.next ?? null })
                )
                .catch(() => undefined)
                .finally(() => setLoading(false));
        }, 200);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [wanted]);
    const first = choices
        ? { key: "", items: choices.repos, next: choices.reposNext ?? null }
        : null;
    const list = pages?.key === wanted ? pages : wanted ? null : first;
    const more = () => {
        if (!list?.next || loading) return;
        setLoading(true);
        readPoll<RepoPage>(REPOS_ROUTE, { query: wanted, cursor: list.next })
            .then((page) => {
                const seen = new Set(list.items.map((entry) => entry.id));
                setPages({
                    key: wanted,
                    items: [
                        ...list.items,
                        ...(page?.items ?? []).filter((entry) => !seen.has(entry.id))
                    ],
                    next: page?.next ?? null
                });
            })
            .catch(() => undefined)
            .finally(() => setLoading(false));
    };
    return { items: list?.items ?? [], next: list?.next ?? null, loading, more };
}

/** The name of a chosen repository no list on screen holds - one past the
 *  first page - read once by its id. */
export function useRepoName(repoId: string, known: readonly RepoEntry[]): string | null {
    const [named, setNamed] = useState<RepoEntry | null>(null);
    const missing =
        repoId !== "" && repoId !== NO_REPO && !known.some((entry) => entry.id === repoId);
    useEffect(() => {
        if (!missing) return;
        let live = true;
        readRepo(repoId)
            .then((entry) => {
                if (live && entry) setNamed(entry);
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [missing, repoId]);
    return named?.id === repoId ? named.name : null;
}

/** A new task's place: the button that opens the repository menu. */
/** The repository list: search, the empty workspace, every connected
 *  repository a page at a time, and the ways to connect more. */
function RepoItems({
    choices,
    repoId,
    onRepo,
    onRefresh,
    refreshing,
    query,
    onQuery
}: {
    choices: PolarCodeChoices | null;
    repoId: string;
    onRepo: (id: string) => void;
    onRefresh: () => void;
    refreshing: boolean;
    query: string;
    onQuery: (query: string) => void;
}) {
    const t = useTranslations("polar");
    const list = useRepoList(choices, query);
    const repos = choices?.repos ?? [];
    const shown = list.items;
    const searching = query.trim().length > 0;
    return (
        <>
            {repos.length > 0 ? (
                <MenuSearch value={query} onChange={onQuery} placeholder={t("code.searchRepos")} />
            ) : null}
            {searching ? null : (
                <DropdownMenuItem onSelect={() => onRepo(NO_REPO)} className="items-start">
                    <FolderGit2 className="mt-0.5 size-3.5 shrink-0" />
                    <span className="flex min-w-0 flex-col">
                        <span className="truncate">{t("code.workspace")}</span>
                        <span className="text-xs text-muted-foreground">
                            {t("code.workspaceHint")}
                        </span>
                    </span>
                    <Mark on={repoId === NO_REPO} />
                </DropdownMenuItem>
            )}
            {shown.map((entry) => (
                <DropdownMenuItem key={entry.id} onSelect={() => onRepo(entry.id)}>
                    <FolderGit2 className="size-3.5 shrink-0" />
                    <span className="min-w-0 truncate" title={entry.name}>
                        {entry.name}
                    </span>
                    <Mark on={entry.id === repoId} />
                </DropdownMenuItem>
            ))}
            {list.next ? (
                <DropdownMenuItem
                    disabled={list.loading}
                    onSelect={(event) => {
                        // Stays open: the next page lands right here.
                        event.preventDefault();
                        list.more();
                    }}
                >
                    <ChevronDown className="size-3.5 shrink-0" />
                    <span className="min-w-0 truncate">{t("code.moreRepos")}</span>
                </DropdownMenuItem>
            ) : null}
            {searching && shown.length === 0 && !list.loading ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                    {t("code.noRepoMatch")}
                </p>
            ) : null}
            <DropdownMenuSeparator />
            {choices?.installUrl ? (
                <DropdownMenuItem asChild className="items-start">
                    <a href={choices.installUrl} target="_blank" rel="noopener noreferrer">
                        <Plus className="mt-0.5 size-3.5 shrink-0" />
                        <span className="flex min-w-0 flex-col">
                            <span className="truncate">{t("code.addRepos")}</span>
                            <span className="text-xs text-muted-foreground">
                                {t("code.addReposHint")}
                            </span>
                        </span>
                        <ExternalLink className="ml-auto mt-0.5 size-3.5 shrink-0" />
                    </a>
                </DropdownMenuItem>
            ) : (
                <DropdownMenuItem disabled className="items-start">
                    <Plus className="mt-0.5 size-3.5 shrink-0" />
                    <span className="flex min-w-0 flex-col">
                        <span className="truncate">{t("code.addRepos")}</span>
                        <span className="text-xs">{t("code.addReposUnavailable")}</span>
                    </span>
                </DropdownMenuItem>
            )}
            <DropdownMenuItem asChild>
                <Link href="/automations/code-review">
                    <FolderGit2 className="size-3.5 shrink-0" />
                    <span className="min-w-0 truncate">{t("code.connectInAgents")}</span>
                </Link>
            </DropdownMenuItem>
            <DropdownMenuItem
                disabled={refreshing}
                onSelect={(event) => {
                    // Stays open: the list it refreshes is right here.
                    event.preventDefault();
                    onRefresh();
                }}
            >
                <RefreshCw
                    className={cn("size-3.5 shrink-0", refreshing && "motion-safe:animate-spin")}
                />
                <span className="min-w-0 truncate">{t("code.refresh")}</span>
            </DropdownMenuItem>
        </>
    );
}

/** Branch lists already read, by repository, so reopening the chip is instant. */
const branchCache = new Map<string, { value: PolarCodeBranches; at: number }>();

/** How long a cached list is shown without asking GitHub again. */
const BRANCH_TTL_MS = 30_000;

function sameBranches(a: PolarCodeBranches, b: PolarCodeBranches): boolean {
    return (
        a.defaultBranch === b.defaultBranch &&
        a.branches.length === b.branches.length &&
        a.branches.every((name, at) => name === b.branches[at])
    );
}

/** The chip's list for one repository: the cached one at once, read again in
 *  the background once it is older than `BRANCH_TTL_MS`. */
function useBranches(repoId: string, enabled: boolean) {
    const [state, setState] = useState<{
        repoId: string;
        value: PolarCodeBranches | null;
        failed: boolean;
    }>(() => ({ repoId, value: branchCache.get(repoId)?.value ?? null, failed: false }));
    useEffect(() => {
        if (!enabled) return;
        const cached = branchCache.get(repoId) ?? null;
        setState({ repoId, value: cached?.value ?? null, failed: false });
        if (cached && Date.now() - cached.at < BRANCH_TTL_MS) return;
        let live = true;
        fetch(`/api/polar/code/branches?repo=${encodeURIComponent(repoId)}`)
            .then(async (response) => {
                const body = response.ok
                    ? ((await response.json()) as { value?: PolarCodeBranches | null })
                    : null;
                if (!live) return;
                if (body?.value && Array.isArray(body.value.branches)) {
                    const value = body.value;
                    branchCache.set(repoId, { value, at: Date.now() });
                    setState((current) =>
                        current.repoId === repoId &&
                        current.value !== null &&
                        sameBranches(current.value, value)
                            ? current
                            : { repoId, value, failed: false }
                    );
                } else if (!cached) setState({ repoId, value: null, failed: true });
            })
            .catch(() => {
                if (live && !cached) setState({ repoId, value: null, failed: true });
            });
        return () => {
            live = false;
        };
    }, [repoId, enabled]);
    return state.repoId === repoId ? state : { repoId, value: null, failed: false };
}

/** Most branches the list draws at once; a search reaches the rest. */
const BRANCHES_SHOWN = 100;

/**
 * Where a new task works, as one chip under the composer: the repository and
 * the branch it starts from. The menu lists the repositories; the branch is a
 * submenu at its top, searchable, the default one first, and takes a name that
 * is not listed yet. An empty branch means the repository's default, which the
 * chip names once it is known.
 */
export function CodeWhereChip({
    choices,
    repoId,
    onRepo,
    onRefresh,
    refreshing,
    branch,
    onBranch,
    disabled
}: {
    /** Null while the choices are on their way. */
    choices: PolarCodeChoices | null;
    repoId: string;
    onRepo: (id: string) => void;
    onRefresh: () => void;
    refreshing: boolean;
    /** The branch typed or chosen; empty for the default one. */
    branch: string;
    onBranch: (branch: string) => void;
    disabled: boolean;
}) {
    const t = useTranslations("polar");
    const [open, setOpen] = useState(false);
    const [repoQuery, setRepoQuery] = useState("");
    const [query, setQuery] = useState("");
    const known = choices?.repos ?? [];
    const chosenRepo = useRepoName(repoId, known);
    const repoName =
        known.find((entry) => entry.id === repoId)?.name ?? chosenRepo ?? t("code.workspace");
    const hasRepo = repoId !== "" && repoId !== NO_REPO;
    const { value, failed } = useBranches(repoId, hasRepo);
    const fallback = value?.defaultBranch ?? null;
    const chosen = branch.trim();
    const branchName = chosen || fallback || t("code.branchPlaceholder");
    const typed = query.trim();
    const matches = (value?.branches ?? []).filter((name) => menuSearchMatches(name, query));
    const listed = value?.branches.includes(typed) ?? false;
    const label = hasRepo ? `${repoName} - ${branchName}` : repoName;
    const choose = (name: string) => {
        onBranch(name === fallback ? "" : name);
        setOpen(false);
    };

    return (
        <DropdownMenu
            open={open}
            onOpenChange={(next) => {
                if (!next) {
                    setRepoQuery("");
                    setQuery("");
                }
                setOpen(next);
            }}
        >
            <DropdownMenuTrigger asChild disabled={disabled || (choices === null && refreshing)}>
                <button
                    type="button"
                    aria-label={`${t("code.where")}: ${label}`}
                    title={label}
                    className="flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground disabled:opacity-60 [@media(pointer:coarse)]:h-11"
                >
                    <FolderGit2 className="size-3.5 shrink-0" aria-hidden />
                    <span className="min-w-0 truncate text-foreground">{repoName}</span>
                    {hasRepo ? (
                        <>
                            <GitBranch className="size-3.5 shrink-0" aria-hidden />
                            <span className="min-w-0 max-w-[40%] shrink-[2] truncate">
                                {branchName}
                            </span>
                        </>
                    ) : null}
                    <ChevronDown className="size-3.5 shrink-0" aria-hidden />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="start"
                className="max-h-[min(26rem,var(--radix-dropdown-menu-content-available-height))] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain pt-2"
                onEscapeKeyDown={(event) => {
                    if (!repoQuery) return;
                    event.preventDefault();
                    setRepoQuery("");
                }}
            >
                {hasRepo && !repoQuery.trim() ? (
                    <>
                        <DropdownMenuSub onOpenChange={(next) => (next ? undefined : setQuery(""))}>
                            <DropdownMenuSubTrigger aria-label={`${t("code.branch")}: ${branchName}`}>
                                <GitBranch className="size-3.5 shrink-0" />
                                <span className="min-w-0 truncate" title={branchName}>
                                    {branchName}
                                </span>
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent
                                className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-72 max-w-[calc(100vw-2rem)] pt-2"
                                onEscapeKeyDown={(event) => {
                                    if (!query) return;
                                    event.preventDefault();
                                    setQuery("");
                                }}
                            >
                                <MenuSearch
                                    value={query}
                                    onChange={setQuery}
                                    placeholder={t("code.searchBranches")}
                                />
                                {value === null && !failed ? (
                                    <div className="space-y-1.5 px-2 py-1.5" aria-hidden>
                                        {[0, 1, 2].map((key) => (
                                            <div
                                                key={key}
                                                className="h-5 rounded bg-muted motion-safe:animate-pulse"
                                            />
                                        ))}
                                    </div>
                                ) : null}
                                {failed ? (
                                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                                        {t("code.branchesFailed")}
                                    </p>
                                ) : null}
                                {matches.slice(0, BRANCHES_SHOWN).map((name) => (
                                    <DropdownMenuItem key={name} onSelect={() => choose(name)}>
                                        <GitBranch className="size-3.5 shrink-0" />
                                        <span className="min-w-0 truncate" title={name}>
                                            {name}
                                        </span>
                                        {name === fallback ? (
                                            <span className="shrink-0 rounded bg-muted px-1 text-[0.6875rem] text-muted-foreground">
                                                {t("code.branchDefault")}
                                            </span>
                                        ) : null}
                                        <Mark on={chosen ? name === chosen : name === fallback} />
                                    </DropdownMenuItem>
                                ))}
                                {value !== null && typed && matches.length === 0 && !listed ? (
                                    <p className="px-2 py-1.5 text-center text-xs text-muted-foreground">
                                        {t("code.noBranchMatch")}
                                    </p>
                                ) : null}
                                {typed && !listed ? (
                                    <DropdownMenuItem onSelect={() => choose(typed)}>
                                        <Plus className="size-3.5 shrink-0" />
                                        <span className="min-w-0 truncate" title={typed}>
                                            {t("code.branchUse", { name: typed })}
                                        </span>
                                    </DropdownMenuItem>
                                ) : null}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSeparator />
                    </>
                ) : null}
                <RepoItems
                    choices={choices}
                    repoId={repoId}
                    onRepo={(id) => {
                        onRepo(id);
                        setOpen(false);
                    }}
                    onRefresh={onRefresh}
                    refreshing={refreshing}
                    query={repoQuery}
                    onQuery={setRepoQuery}
                />
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function Mark({ on }: { on: boolean }) {
    return <Check className={cn("ml-auto size-3.5 shrink-0 text-primary", !on && "opacity-0")} />;
}

type PolarT = NamespaceTranslator<"polar">;

/** The account an option names, said as an API key where it is one. */
function accountName(option: AgentOption, t: PolarT): string | null {
    if (!option.account) return null;
    if (option.machine) return t("code.machineAccount");
    return option.apiKey ? t("code.apiKeyAccount", { account: option.account }) : option.account;
}

/** What an agent option is called: its name, and the account where one is named. */
function agentName(option: AgentOption, t: PolarT): string {
    const account = accountName(option, t);
    return account ? `${option.label} - ${account}` : option.label;
}

/** The agent, on the composer where Chat has its model picker, in the same look. */
export function AgentPicker({
    agents,
    value,
    onChange,
    disabled
}: {
    /** Null while the choices are on their way. */
    agents: readonly AgentOption[] | null;
    value: string;
    onChange: (key: string) => void;
    disabled: boolean;
}) {
    const t = useTranslations("polar");
    const [query, setQuery] = useState("");
    const polar = value === POLAR_ENGINE;
    const picked = polar ? null : (agents?.find((option) => option.key === value) ?? null);
    const shown = (agents ?? []).filter((option) =>
        menuSearchMatches(agentName(option, t), query)
    );
    const searchable = (agents?.length ?? 0) > 6;
    return (
        <DropdownMenu onOpenChange={(next) => (next ? undefined : setQuery(""))}>
            <DropdownMenuTrigger asChild disabled={disabled || agents === null}>
                <button
                    type="button"
                    title={polar ? t("code.polarEngine") : picked ? agentName(picked, t) : t("code.agent")}
                    aria-label={`${t("code.agent")}: ${polar ? t("code.polarEngine") : picked ? agentName(picked, t) : ""}`}
                    className={cn(MODEL_TRIGGER, "disabled:opacity-60")}
                >
                    {polar ? (
                        <Sparkles className="size-3.5 shrink-0" aria-hidden />
                    ) : picked ? (
                        <AgentLogo
                            id={picked.cli}
                            label={picked.label}
                            className="size-3.5 shrink-0"
                        />
                    ) : (
                        <Bot className="size-3.5 shrink-0" aria-hidden />
                    )}
                    <span className="truncate text-foreground">
                        {polar ? t("code.polarEngine") : (picked?.label ?? t("code.agent"))}
                    </span>
                    {picked?.account ? (
                        <span className="min-w-0 truncate" title={accountName(picked, t) ?? undefined}>
                            {accountName(picked, t)}
                        </span>
                    ) : null}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="start"
                className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain pt-2"
            >
                {searchable ? (
                    <MenuSearch
                        value={query}
                        onChange={setQuery}
                        placeholder={t("code.searchAgents")}
                    />
                ) : null}
                <DropdownMenuLabel>{t("code.agent")}</DropdownMenuLabel>
                {menuSearchMatches(t("code.polarEngine"), query) ? (
                    <DropdownMenuItem onSelect={() => onChange(POLAR_ENGINE)} className="items-start">
                        <Sparkles className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                        <span className="flex min-w-0 flex-col">
                            <span className="truncate">{t("code.polarEngine")}</span>
                            <span className="text-xs text-muted-foreground">
                                {t("code.polarEngineHint")}
                            </span>
                        </span>
                        <Mark on={polar} />
                    </DropdownMenuItem>
                ) : null}
                {shown.map((option) => (
                    <DropdownMenuItem
                        key={option.key}
                        onSelect={() => onChange(option.key)}
                        className="items-start"
                    >
                        <AgentLogo
                            id={option.cli}
                            label={option.label}
                            className="mt-0.5 size-3.5 shrink-0"
                        />
                        <span className="flex min-w-0 flex-col">
                            <span className="truncate" title={option.label}>
                                {option.label}
                            </span>
                            {option.account || option.readiness === "missing" ? (
                                <span
                                    className="truncate text-xs text-muted-foreground"
                                    title={accountName(option, t) ?? undefined}
                                >
                                    {option.readiness === "missing"
                                        ? t("code.notSignedIn")
                                        : accountName(option, t)}
                                </span>
                            ) : null}
                        </span>
                        <Mark on={option.key === value} />
                    </DropdownMenuItem>
                ))}
                {searchable && query.trim() && shown.length === 0 ? (
                    <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                        {t("code.noAgentMatch")}
                    </p>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                    <Link href="/account/ai-keys">{t("code.apiKeys")}</Link>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** Where the picked permission mode is kept, so the next task starts on it. */
export const PERMISSION_MODE_KEY = "polar.code.permissionMode";

/** The mode a new task starts on: the one picked last, or full access - what a
 *  session in its own machine always did. */
export function readPermissionMode(stored: string | null): core.SessionPermissionMode {
    return core.sessionPermissionMode(stored) ?? "full";
}

/** How the agent asks before it acts, picked beside the agent. Only for a tool
 *  whose questions Polaris can answer. */
export function PermissionModePicker({
    value,
    onChange,
    disabled
}: {
    value: core.SessionPermissionMode;
    onChange: (mode: core.SessionPermissionMode) => void;
    disabled: boolean;
}) {
    const t = useTranslations("polar");
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={disabled}>
                <button
                    type="button"
                    title={t(`code.mode.${value}.hint`)}
                    aria-label={`${t("code.mode.label")}: ${t(`code.mode.${value}.name`)}`}
                    className={cn(MODEL_TRIGGER, "disabled:opacity-60")}
                >
                    <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate text-foreground">
                        {t(`code.mode.${value}.name`)}
                    </span>
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-2rem)]">
                <DropdownMenuLabel>{t("code.mode.label")}</DropdownMenuLabel>
                {core.SESSION_PERMISSION_MODES.map((mode) => (
                    <DropdownMenuItem
                        key={mode}
                        onSelect={() => onChange(mode)}
                        className="items-start"
                    >
                        <span className="flex min-w-0 flex-col">
                            <span className="truncate">{t(`code.mode.${mode}.name`)}</span>
                            <span className="text-xs text-muted-foreground">
                                {t(`code.mode.${mode}.hint`)}
                            </span>
                        </span>
                        <Mark on={mode === value} />
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
const CHIP =
    "flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground disabled:opacity-60 [@media(pointer:coarse)]:h-11";
const CHIP_MENU =
    "max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain pt-2";

/** An issue the task starts from, as the chip names it. */
export type PickedIssue = Pick<RepoIssue, "number" | "title">;

/** How long typing settles before GitHub is searched. */
const ISSUE_SEARCH_MS = 300;

/** The repository's open issues for the chip: GitHub's own search for what is
 *  typed, asked once the typing settles, the stale answer dropped. */
function useIssues(repoId: string, query: string, open: boolean) {
    const [state, setState] = useState<{
        key: string;
        items: readonly RepoIssue[] | null;
        failed: boolean;
    }>({ key: "", items: null, failed: false });
    const asked = query.trim();
    const key = `${repoId}:${asked}`;
    useEffect(() => {
        if (!open) return;
        const controller = new AbortController();
        const timer = setTimeout(
            () => {
                readPoll<{ items: RepoIssue[] } | null>(
                    "/api/polar/code/issues",
                    { repo: repoId, q: asked },
                    controller.signal
                )
                    .then((answer) =>
                        setState({ key, items: answer?.items ?? null, failed: answer === null })
                    )
                    .catch(() => {
                        if (!controller.signal.aborted)
                            setState({ key, items: null, failed: true });
                    });
            },
            asked ? ISSUE_SEARCH_MS : 0
        );
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [asked, key, open, repoId]);
    return state.key === key ? state : { key, items: null, failed: false };
}

/** Start the task from one of the repository's open issues. */
export function CodeIssueChip({
    repoId,
    issue,
    onIssue,
    disabled
}: {
    repoId: string;
    issue: PickedIssue | null;
    onIssue: (issue: PickedIssue | null) => void;
    disabled: boolean;
}) {
    const t = useTranslations("polar");
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const { items, failed } = useIssues(repoId, query, open);
    const shown = issue ? `#${issue.number} ${issue.title}` : t("code.issue.label");
    return (
        <span className="flex min-w-0 max-w-full items-center gap-0.5">
            <DropdownMenu
                open={open}
                onOpenChange={(next) => {
                    if (!next) setQuery("");
                    setOpen(next);
                }}
            >
                <DropdownMenuTrigger asChild disabled={disabled}>
                    <button
                        type="button"
                        aria-label={`${t("code.issue.label")}: ${issue ? shown : t("code.issue.none")}`}
                        title={issue ? shown : t("code.issue.pick")}
                        className={CHIP}
                    >
                        <CircleDot className="size-3.5 shrink-0" aria-hidden />
                        <span className="min-w-0 truncate">{shown}</span>
                        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    align="start"
                    className={CHIP_MENU}
                    onEscapeKeyDown={(event) => {
                        if (!query) return;
                        event.preventDefault();
                        setQuery("");
                    }}
                >
                    <MenuSearch
                        value={query}
                        onChange={setQuery}
                        placeholder={t("code.issue.search")}
                    />
                    {items === null && !failed ? (
                        <div className="space-y-1.5 px-2 py-1.5" aria-hidden>
                            {[0, 1, 2].map((key) => (
                                <div
                                    key={key}
                                    className="h-5 rounded bg-muted motion-safe:animate-pulse"
                                />
                            ))}
                        </div>
                    ) : null}
                    {failed ? (
                        <p className="px-2 py-1.5 text-xs text-muted-foreground">
                            {t("code.issue.failed")}
                        </p>
                    ) : null}
                    {items?.map((item) => (
                        <DropdownMenuItem
                            key={item.number}
                            onSelect={() => onIssue({ number: item.number, title: item.title })}
                            className="items-start"
                        >
                            <span className="shrink-0 tabular-nums text-muted-foreground">
                                #{item.number}
                            </span>
                            <span className="flex min-w-0 flex-col">
                                <span className="min-w-0 truncate" title={item.title}>
                                    {item.title}
                                </span>
                                {item.labels.length > 0 ? (
                                    <span
                                        className="min-w-0 truncate text-xs text-muted-foreground"
                                        title={item.labels.join(", ")}
                                    >
                                        {item.labels.join(", ")}
                                    </span>
                                ) : null}
                            </span>
                            <Mark on={issue?.number === item.number} />
                        </DropdownMenuItem>
                    ))}
                    {items !== null && items.length === 0 ? (
                        <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                            {query.trim() ? t("code.issue.noMatch") : t("code.issue.empty")}
                        </p>
                    ) : null}
                </DropdownMenuContent>
            </DropdownMenu>
            {issue ? (
                <ChipClear label={t("code.issue.clear")} onClear={() => onIssue(null)} />
            ) : null}
        </span>
    );
}

/** A skill the composer offers: the person's own, by name. */
export interface CodeSkillOption {
    readonly name: string;
    readonly description: string;
}

/** Start the task with one of the person's Polar skills as its instructions. */
export function CodeSkillChip({
    skills,
    skill,
    onSkill,
    disabled
}: {
    skills: readonly CodeSkillOption[];
    skill: string | null;
    onSkill: (skill: string | null) => void;
    disabled: boolean;
}) {
    const t = useTranslations("polar");
    const [query, setQuery] = useState("");
    const shown = skills.filter((option) =>
        menuSearchMatches(`${option.name} ${option.description}`, query)
    );
    return (
        <span className="flex min-w-0 max-w-full items-center gap-0.5">
            <DropdownMenu onOpenChange={(next) => (next ? undefined : setQuery(""))}>
                <DropdownMenuTrigger asChild disabled={disabled}>
                    <button
                        type="button"
                        aria-label={`${t("code.skill.label")}: ${skill ?? t("code.skill.none")}`}
                        title={skill ?? t("code.skill.pick")}
                        className={CHIP}
                    >
                        <Wand2 className="size-3.5 shrink-0" aria-hidden />
                        <span className="min-w-0 truncate">{skill ?? t("code.skill.label")}</span>
                        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className={CHIP_MENU}>
                    {skills.length > 6 ? (
                        <MenuSearch
                            value={query}
                            onChange={setQuery}
                            placeholder={t("code.skill.search")}
                        />
                    ) : null}
                    {shown.map((option) => (
                        <DropdownMenuItem
                            key={option.name}
                            onSelect={() => onSkill(option.name)}
                            className="items-start"
                        >
                            <span className="flex min-w-0 flex-col">
                                <span className="min-w-0 truncate" title={option.name}>
                                    {option.name}
                                </span>
                                {option.description ? (
                                    <span
                                        className="line-clamp-2 text-xs text-muted-foreground"
                                        title={option.description}
                                    >
                                        {option.description}
                                    </span>
                                ) : null}
                            </span>
                            <Mark on={skill === option.name} />
                        </DropdownMenuItem>
                    ))}
                    {skills.length === 0 ? (
                        <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                            {t("code.skill.empty")}
                        </p>
                    ) : null}
                    {skills.length > 0 && shown.length === 0 ? (
                        <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                            {t("code.skill.noMatch")}
                        </p>
                    ) : null}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                        <Link href="/polar/settings/skills">{t("code.skill.manage")}</Link>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            {skill ? (
                <ChipClear label={t("code.skill.clear")} onClear={() => onSkill(null)} />
            ) : null}
        </span>
    );
}

/** One of the person's own agents, as the chip offers it. */
export interface CodePersonaOption {
    readonly id: string;
    readonly name: string;
    readonly description: string;
}

/** "Agent: <name>": the person's own agent whose instructions lead the task,
 *  over whatever model is picked. */
export function CodePersonaChip({
    personas,
    persona,
    onPersona,
    disabled
}: {
    personas: readonly CodePersonaOption[];
    persona: string | null;
    onPersona: (id: string | null) => void;
    disabled: boolean;
}) {
    const t = useTranslations("polar");
    const [query, setQuery] = useState("");
    const picked = personas.find((option) => option.id === persona) ?? null;
    const shown = personas.filter((option) =>
        menuSearchMatches(`${option.name} ${option.description}`, query)
    );
    const label = picked ? t("code.persona.named", { name: picked.name }) : t("code.persona.label");
    return (
        <span className="flex min-w-0 max-w-full items-center gap-0.5">
            <DropdownMenu onOpenChange={(next) => (next ? undefined : setQuery(""))}>
                <DropdownMenuTrigger asChild disabled={disabled}>
                    <button type="button" aria-label={label} title={label} className={CHIP}>
                        <Bot className="size-3.5 shrink-0" aria-hidden />
                        <span className="min-w-0 truncate">{label}</span>
                        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className={CHIP_MENU}>
                    {personas.length > 6 ? (
                        <MenuSearch value={query} onChange={setQuery} placeholder={t("code.persona.search")} />
                    ) : null}
                    {shown.map((option) => (
                        <DropdownMenuItem
                            key={option.id}
                            onSelect={() => onPersona(option.id)}
                            className="items-start"
                        >
                            <span className="flex min-w-0 flex-col">
                                <span className="min-w-0 truncate" title={option.name}>
                                    {option.name}
                                </span>
                                {option.description ? (
                                    <span
                                        className="line-clamp-2 text-xs text-muted-foreground"
                                        title={option.description}
                                    >
                                        {option.description}
                                    </span>
                                ) : null}
                            </span>
                            <Mark on={persona === option.id} />
                        </DropdownMenuItem>
                    ))}
                    {shown.length === 0 ? (
                        <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                            {t("code.persona.noMatch")}
                        </p>
                    ) : null}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                        <Link href={settingsSection("agents")}>{t("code.editAgents")}</Link>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            {picked ? <ChipClear label={t("code.persona.clear")} onClear={() => onPersona(null)} /> : null}
        </span>
    );
}

function ChipClear({ label, onClear }: { label: string; onClear: () => void }) {
    return (
        <button
            type="button"
            onClick={onClear}
            aria-label={label}
            title={label}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card-hover hover:text-foreground [@media(pointer:coarse)]:size-11"
        >
            <X className="size-3.5" aria-hidden />
        </button>
    );
}
