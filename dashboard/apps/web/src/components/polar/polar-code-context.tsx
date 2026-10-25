"use client";

/**
 * Where a Code task works, and who works on it.
 *
 * The repository sits in a bar at the top of the task, so the composer keeps
 * only what Chat's has. The bar opens a menu (a portal with collision
 * handling) to search the connected repositories, pick an empty workspace, and
 * give Polaris's GitHub App more repositories on GitHub - with a refresh for
 * when the person comes back.
 *
 * The branch is a chip under the composer, as the coding agents' own web apps
 * draw it: it opens a searchable list of the repository's branches, the
 * default one first, and takes a name that is not listed yet.
 *
 * The agent is picked on the composer, in the model picker's place and look.
 */

import Link from "next/link";
import type { PolarCodeChoices } from "@/lib/polar/code";
import type { AgentOption } from "@/lib/agents/agent-readiness";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useState, type ReactNode } from "react";
import type { PolarCodeBranches } from "@/lib/polar/code";
import { MODEL_TRIGGER } from "@/components/polar/elements/model-selector";
import {
    Bot,
    Check,
    ChevronDown,
    ExternalLink,
    FolderGit2,
    GitBranch,
    Plus,
    RefreshCw
} from "lucide-react";
import {
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    MenuSearch,
    menuSearchMatches
} from "@polaris/ui";

/** The repository picker's "none": a workspace with nothing checked out. */
export const NO_REPO = "workspace";

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
function Where({ repo, branch }: { repo: string; branch: string }) {
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

/** A new task's place: the button that opens the repository menu. */
export function CodeRepoBar({
    fullPage,
    choices,
    repoId,
    onRepo,
    onRefresh,
    refreshing,
    disabled
}: {
    fullPage: boolean;
    /** Null while the choices are on their way. */
    choices: PolarCodeChoices | null;
    repoId: string;
    onRepo: (id: string) => void;
    onRefresh: () => void;
    refreshing: boolean;
    disabled: boolean;
}) {
    const t = useTranslations("polar");
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const repos = choices?.repos ?? [];
    const repo = repos.find((entry) => entry.id === repoId) ?? null;
    const name = repo?.name ?? t("code.workspace");
    const shown = repos.filter((entry) => menuSearchMatches(entry.name, query));
    const searching = query.trim().length > 0;
    const full = name;

    return (
        <BarRow fullPage={fullPage}>
            <DropdownMenu
                open={open}
                onOpenChange={(next) => {
                    if (!next) setQuery("");
                    setOpen(next);
                }}
            >
                <DropdownMenuTrigger
                    asChild
                    disabled={disabled || (choices === null && refreshing)}
                >
                    <button
                        type="button"
                        aria-label={`${t("code.where")}: ${full}`}
                        title={full}
                        className="-mx-2 flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 hover:bg-card-hover hover:text-foreground disabled:opacity-60"
                    >
                        <Where repo={name} branch="" />
                        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                    align="start"
                    className="max-h-[min(26rem,var(--radix-dropdown-menu-content-available-height))] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain pt-2"
                    onEscapeKeyDown={(event) => {
                        if (!query) return;
                        event.preventDefault();
                        setQuery("");
                    }}
                >
                    {repos.length > 0 ? (
                        <MenuSearch
                            value={query}
                            onChange={setQuery}
                            placeholder={t("code.searchRepos")}
                        />
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
                    {searching && shown.length === 0 ? (
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
                        <Link href="/apps/agents/repos">
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
                            className={cn(
                                "size-3.5 shrink-0",
                                refreshing && "motion-safe:animate-spin"
                            )}
                        />
                        <span className="min-w-0 truncate">{t("code.refresh")}</span>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </BarRow>
    );
}

/** Branch lists already read, by repository, so reopening the chip is instant. */
const branchCache = new Map<string, PolarCodeBranches>();

/** The chip's list for one repository: read once, then served from memory. */
function useBranches(repoId: string, enabled: boolean) {
    const [state, setState] = useState<{
        repoId: string;
        value: PolarCodeBranches | null;
        failed: boolean;
    }>(() => ({ repoId, value: branchCache.get(repoId) ?? null, failed: false }));
    useEffect(() => {
        if (!enabled) return;
        const cached = branchCache.get(repoId) ?? null;
        setState({ repoId, value: cached, failed: false });
        if (cached) return;
        let live = true;
        fetch(`/api/polar/code/branches?repo=${encodeURIComponent(repoId)}`)
            .then(async (response) => {
                const body = response.ok
                    ? ((await response.json()) as { value?: PolarCodeBranches | null })
                    : null;
                if (!live) return;
                if (body?.value && Array.isArray(body.value.branches)) {
                    branchCache.set(repoId, body.value);
                    setState({ repoId, value: body.value, failed: false });
                } else setState({ repoId, value: null, failed: true });
            })
            .catch(() => {
                if (live) setState({ repoId, value: null, failed: true });
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
 * The branch a new task starts from, as a chip under the composer. Empty means
 * the repository's default branch, which the chip names once it is known.
 */
export function CodeBranchChip({
    repoId,
    branch,
    onBranch,
    disabled
}: {
    repoId: string;
    /** The branch typed or chosen; empty for the default one. */
    branch: string;
    onBranch: (branch: string) => void;
    disabled: boolean;
}) {
    const t = useTranslations("polar");
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const { value, failed } = useBranches(repoId, true);
    const fallback = value?.defaultBranch ?? null;
    const chosen = branch.trim();
    const shownName = chosen || fallback || t("code.branchPlaceholder");
    const typed = query.trim();
    const matches = (value?.branches ?? []).filter((name) => menuSearchMatches(name, query));
    const listed = value?.branches.includes(typed) ?? false;
    const choose = (name: string) => {
        onBranch(name === fallback ? "" : name);
        setOpen(false);
    };

    return (
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
                    aria-label={`${t("code.branch")}: ${shownName}`}
                    title={shownName}
                    className="flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground disabled:opacity-60 [@media(pointer:coarse)]:h-11"
                >
                    <GitBranch className="size-3.5 shrink-0" aria-hidden />
                    <span className="min-w-0 truncate">{shownName}</span>
                    <ChevronDown className="size-3.5 shrink-0" aria-hidden />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="start"
                className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain pt-2"
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
                {value !== null && typed && matches.length === 0 && listed === false ? (
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
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function Mark({ on }: { on: boolean }) {
    return <Check className={cn("ml-auto size-3.5 shrink-0 text-primary", !on && "opacity-0")} />;
}

/** What an agent option is called: its name, and the account where one is named. */
function agentName(option: AgentOption): string {
    return option.account ? `${option.label} - ${option.account}` : option.label;
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
    const picked = agents?.find((option) => option.key === value) ?? null;
    const shown = (agents ?? []).filter((option) => menuSearchMatches(agentName(option), query));
    const searchable = (agents?.length ?? 0) > 6;
    return (
        <DropdownMenu onOpenChange={(next) => (next ? undefined : setQuery(""))}>
            <DropdownMenuTrigger asChild disabled={disabled || agents === null}>
                <button
                    type="button"
                    title={picked ? agentName(picked) : t("code.agent")}
                    aria-label={`${t("code.agent")}: ${picked ? agentName(picked) : ""}`}
                    className={cn(MODEL_TRIGGER, "disabled:opacity-60")}
                >
                    <Bot className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate text-foreground">
                        {picked?.label ?? t("code.agent")}
                    </span>
                    {picked?.account ? (
                        <span className="min-w-0 truncate" title={picked.account}>
                            {picked.account}
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
                {shown.map((option) => (
                    <DropdownMenuItem
                        key={option.key}
                        onSelect={() => onChange(option.key)}
                        className="items-start"
                    >
                        <Bot className="mt-0.5 size-3.5 shrink-0" />
                        <span className="flex min-w-0 flex-col">
                            <span className="truncate" title={option.label}>
                                {option.label}
                            </span>
                            {option.account || option.readiness === "missing" ? (
                                <span
                                    className="truncate text-xs text-muted-foreground"
                                    title={option.account ?? undefined}
                                >
                                    {option.readiness === "missing"
                                        ? t("code.notSignedIn")
                                        : option.account}
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
                    <Link href="/apps/agents/settings">{t("code.agentSettings")}</Link>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
