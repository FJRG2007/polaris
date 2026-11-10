"use client";

/**
 * The issue search: a line of Sentry syntax, with the filters it holds drawn as
 * chips and the common ones a dropdown away, so nobody has to remember that
 * "assigned:me" is how you say "mine".
 */

import * as core from "@polaris/core";
import { useEffect, useState } from "react";
import type { NamespaceKey } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ArrowDownWideNarrow, Check, ChevronDown, Search, X } from "lucide-react";
import {
    ISSUE_SORTS,
    ISSUE_STATUS_FILTERS,
    parseIssueQuery,
    parseRange,
    serializeIssueQuery,
    type IssueQuery,
    type IssueSort,
    type SeenRange
} from "@/lib/telemetry/issue-query";
import {
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@polaris/ui";

type Key = NamespaceKey<"telemetry">;

const RANGES = ["-1h", "-24h", "-7d", "-14d", "-30d"] as const;

function rangeLabel(t: (key: Key, values?: Record<string, string | number>) => string, range: SeenRange) {
    return t(range.within ? "search.within" : "search.olderThan", {
        amount: range.amount,
        unit: t(`search.units.${range.unit}` as Key)
    });
}

export function IssueSearchBar({
    value,
    sort,
    onChange,
    showProject
}: {
    value: string;
    sort: IssueSort;
    onChange: (value: string, sort: IssueSort) => void;
    /** The cross-project list offers a `project:` chip; a project's own does not. */
    showProject: boolean;
}) {
    const t = useTranslations("telemetry");
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);
    const query = parseIssueQuery(value);
    const change = (next: Partial<IssueQuery>) =>
        onChange(serializeIssueQuery({ ...query, ...next }), sort);

    const chips: { key: string; label: string; clear: Partial<IssueQuery> }[] = [];
    if (query.status) {
        chips.push({
            key: "status",
            label: t(`view.statuses.${query.status}` as Key),
            clear: { status: null }
        });
    }
    if (query.assigned) {
        chips.push({
            key: "assigned",
            label:
                query.assigned === "me" || query.assigned === "none" || query.assigned === "any"
                    ? t(`search.assigned.${query.assigned}` as Key)
                    : t("search.assigned.someone"),
            clear: { assigned: null }
        });
    }
    if (query.levels.length > 0) {
        chips.push({
            key: "level",
            label: query.levels.map((level) => t(`search.levels.${level}` as Key)).join(", "),
            clear: { levels: [] }
        });
    }
    if (query.environment) {
        chips.push({
            key: "env",
            label: t("search.environmentIs", { value: query.environment }),
            clear: { environment: null }
        });
    }
    if (query.release) {
        chips.push({
            key: "release",
            label: t("search.releaseIs", { value: query.release }),
            clear: { release: null }
        });
    }
    if (query.project && showProject) {
        chips.push({
            key: "project",
            label: t("search.projectIs", { value: query.project }),
            clear: { project: null }
        });
    }
    if (query.firstSeen) {
        chips.push({
            key: "first",
            label: `${t("search.firstSeen")}: ${rangeLabel(t, query.firstSeen)}`,
            clear: { firstSeen: null }
        });
    }
    if (query.lastSeen) {
        chips.push({
            key: "last",
            label: `${t("search.lastSeen")}: ${rangeLabel(t, query.lastSeen)}`,
            clear: { lastSeen: null }
        });
    }

    return (
        <div className="flex flex-col gap-2">
            <form
                className="flex min-w-0 flex-col gap-2 sm:flex-row"
                onSubmit={(event) => {
                    event.preventDefault();
                    onChange(serializeIssueQuery(parseIssueQuery(draft)), sort);
                }}
            >
                <div className="relative min-w-0 flex-1">
                    <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={() => {
                            if (draft !== value) onChange(serializeIssueQuery(parseIssueQuery(draft)), sort);
                        }}
                        maxLength={500}
                        placeholder={t("search.placeholder")}
                        aria-label={t("search.label")}
                        className="h-8 w-full rounded-md border border-border bg-field pl-7 pr-2 font-mono text-xs hover:border-border-strong focus:border-border-strong"
                    />
                </div>
                <div className="flex flex-wrap items-center gap-1">
                    <FilterMenu label={t("search.status")}>
                        {ISSUE_STATUS_FILTERS.map((status) => (
                            <Choice
                                key={status}
                                on={query.status === status}
                                onPick={() => change({ status })}
                            >
                                {t(`view.statuses.${status}` as Key)}
                            </Choice>
                        ))}
                        <Choice on={query.status === null} onPick={() => change({ status: null })}>
                            {t("view.statuses.all")}
                        </Choice>
                    </FilterMenu>
                    <FilterMenu label={t("search.assignee")}>
                        {(["me", "none", "any"] as const).map((who) => (
                            <Choice
                                key={who}
                                on={query.assigned === who}
                                onPick={() => change({ assigned: query.assigned === who ? null : who })}
                            >
                                {t(`search.assigned.${who}` as Key)}
                            </Choice>
                        ))}
                    </FilterMenu>
                    <FilterMenu label={t("search.level")}>
                        {core.TELEMETRY_LEVELS.map((level) => (
                            <Choice
                                key={level}
                                on={query.levels.includes(level)}
                                keepOpen
                                onPick={() =>
                                    change({
                                        levels: query.levels.includes(level)
                                            ? query.levels.filter((entry) => entry !== level)
                                            : [...query.levels, level]
                                    })
                                }
                            >
                                {t(`search.levels.${level}` as Key)}
                            </Choice>
                        ))}
                    </FilterMenu>
                    <FilterMenu label={t("search.seen")}>
                        <p className="px-2 py-1 text-[0.6875rem] text-muted-foreground">
                            {t("search.firstSeen")}
                        </p>
                        {RANGES.map((range) => {
                            const parsed = parseRange(range)!;
                            return (
                                <Choice
                                    key={`f${range}`}
                                    on={serializeIssueQuery({ ...query, firstSeen: parsed }) === value}
                                    onPick={() => change({ firstSeen: parsed })}
                                >
                                    {rangeLabel(t, parsed)}
                                </Choice>
                            );
                        })}
                        <DropdownMenuSeparator />
                        <p className="px-2 py-1 text-[0.6875rem] text-muted-foreground">
                            {t("search.lastSeen")}
                        </p>
                        {RANGES.map((range) => {
                            const parsed = parseRange(range)!;
                            return (
                                <Choice
                                    key={`l${range}`}
                                    on={serializeIssueQuery({ ...query, lastSeen: parsed }) === value}
                                    onPick={() => change({ lastSeen: parsed })}
                                >
                                    {rangeLabel(t, parsed)}
                                </Choice>
                            );
                        })}
                    </FilterMenu>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                <ArrowDownWideNarrow className="size-3.5" />
                                {t(`search.sorts.${sort}` as Key)}
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            {ISSUE_SORTS.map((entry) => (
                                <Choice key={entry} on={entry === sort} onPick={() => onChange(value, entry)}>
                                    {t(`search.sorts.${entry}` as Key)}
                                </Choice>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </form>
            {chips.length > 0 && (
                <ul className="flex flex-wrap gap-1" aria-label={t("search.active")}>
                    {chips.map((chip) => (
                        <li key={chip.key} className="min-w-0">
                            <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted py-0.5 pl-2 pr-1 text-xs">
                                <span className="truncate" title={chip.label}>
                                    {chip.label}
                                </span>
                                <button
                                    type="button"
                                    aria-label={t("search.remove", { filter: chip.label })}
                                    onClick={() => change(chip.clear)}
                                    className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                                >
                                    <X className="size-3" />
                                </button>
                            </span>
                        </li>
                    ))}
                    <li>
                        <button
                            type="button"
                            onClick={() => onChange("", sort)}
                            className="px-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                        >
                            {t("search.clearAll")}
                        </button>
                    </li>
                </ul>
            )}
        </div>
    );
}

function FilterMenu({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs transition-colors hover:bg-muted"
                >
                    {label}
                    <ChevronDown className="size-3 text-muted-foreground" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] min-w-44 overflow-y-auto overscroll-contain">
                {children}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function Choice({
    on,
    onPick,
    keepOpen,
    children
}: {
    on: boolean;
    onPick: () => void;
    keepOpen?: boolean;
    children: React.ReactNode;
}) {
    return (
        <DropdownMenuItem
            onSelect={(event) => {
                if (keepOpen) event.preventDefault();
                onPick();
            }}
        >
            <Check className={cn("size-3.5", on ? "text-primary" : "invisible")} />
            {children}
        </DropdownMenuItem>
    );
}
