"use client";

/**
 * Where a Code task works, and who works on it.
 *
 * The repository and the branch sit in a bar at the top of the task, the way
 * the coding agents' own web apps show "repo - branch" above a task, so the
 * composer keeps only what Chat's has. The bar opens a menu (a portal with
 * collision handling) to search the connected repositories, set the branch,
 * pick an empty workspace, and give Polaris's GitHub App more repositories on
 * GitHub - with a refresh for when the person comes back.
 *
 * The agent is picked on the composer, in the model picker's place and look.
 */

import Link from "next/link";
import type { PolarCodeChoices } from "@/lib/polar/code";
import type { AgentOption } from "@/lib/agents/agent-readiness";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useState, type ReactNode, type KeyboardEvent } from "react";
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
            <span className="min-w-0 truncate text-foreground" title={repo}>{repo}</span>
            {branch ? (
                <>
                    <GitBranch className="size-3.5 shrink-0" aria-hidden />
                    <span className="min-w-0 max-w-[40%] shrink-[2] truncate" title={branch}>{branch}</span>
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
    branch,
    onBranch,
    onRefresh,
    refreshing,
    disabled
}: {
    fullPage: boolean;
    /** Null while the choices are on their way. */
    choices: PolarCodeChoices | null;
    repoId: string;
    onRepo: (id: string) => void;
    branch: string;
    onBranch: (branch: string) => void;
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
    const full = repo && branch.trim() ? `${name} - ${branch.trim()}` : name;

    /** The branch field keeps its typing from the menu, which would read each
     *  letter as a jump to an option; escape still closes and enter is done. */
    const branchKeys = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Escape") return;
        event.stopPropagation();
        if (event.key === "Enter") {
            event.preventDefault();
            setOpen(false);
        }
    };

    return (
        <BarRow fullPage={fullPage}>
            <DropdownMenu
                open={open}
                onOpenChange={(next) => {
                    if (!next) setQuery("");
                    setOpen(next);
                }}
            >
                <DropdownMenuTrigger asChild disabled={disabled || choices === null}>
                    <button
                        type="button"
                        aria-label={`${t("code.where")}: ${full}`}
                        title={full}
                        className="-mx-2 flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 hover:bg-card-hover hover:text-foreground disabled:opacity-60"
                    >
                        <Where
                            repo={name}
                            branch={repo ? branch.trim() || t("code.branchPlaceholder") : ""}
                        />
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
                    {repo ? (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuLabel>{t("code.branch")}</DropdownMenuLabel>
                            <div className="flex items-center gap-2 px-2 pb-1">
                                <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                                <input
                                    aria-label={t("code.branch")}
                                    value={branch}
                                    onChange={(event) => onBranch(event.target.value)}
                                    onKeyDown={branchKeys}
                                    placeholder={t("code.branchPlaceholder")}
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    spellCheck={false}
                                    className="h-7 w-full min-w-0 rounded-md border border-border bg-field px-2 text-sm outline-none placeholder:text-foreground-subtle focus:border-border-strong"
                                />
                            </div>
                        </>
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

function Mark({ on }: { on: boolean }) {
    return (
        <Check className={cn("ml-auto size-3.5 shrink-0 text-primary", !on && "opacity-0")} />
    );
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
                        <span className="min-w-0 truncate" title={picked.account}>{picked.account}</span>
                    ) : null}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="start"
                className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain pt-2"
            >
                {searchable ? (
                    <MenuSearch value={query} onChange={setQuery} placeholder={t("picker.search")} />
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
                        {t("picker.noMatch")}
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
