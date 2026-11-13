"use client";

/**
 * What the update on offer carries, grouped the way somebody deciding whether
 * to install reads it: security fixes first, with their severity, then what is
 * new, what was fixed, and what got faster; internal upkeep last, folded
 * (`lib/changelog-groups`). Read from the commits (`lib/update-changelog`), so
 * it is there for every build without anybody writing release notes; past what
 * the screen lists, the rest is a count and a link to the full comparison.
 *
 * Compact on purpose: one line per change, only Security and New open, a few
 * rows per group before "Show all", and an opened group scrolls inside a
 * bounded height instead of pushing the Update button off the screen.
 */

import { updateChangelogAction } from "./actions";
import { Badge, Skeleton, cn } from "@polaris/ui";
import type { ChangelogEntry } from "@polaris/core";
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, ShieldAlert } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { UpdateChangelog as Changelog } from "@/lib/update-changelog";
import { groupChangelog, type ChangelogGroup } from "@/lib/changelog-groups";

/** Rows shown per group before "Show all". */
const FOLDED = 4;

/** Groups open on arrival; the rest wait for a click. */
const OPEN_BY_DEFAULT: ReadonlySet<ChangelogGroup> = new Set(["security", "feature"]);

const SEVERITY_BADGE = {
    critical: "danger",
    high: "danger",
    medium: "warning",
    low: "neutral"
} as const;

export function UpdateChangelog({ head }: { head: string }) {
    const t = useTranslations("admin");
    const [changelog, setChangelog] = useState<Changelog | null | undefined>(undefined);
    const [expanded, setExpanded] = useState<Partial<Record<ChangelogGroup, boolean>>>({});
    const [showAll, setShowAll] = useState<Partial<Record<ChangelogGroup, boolean>>>({});

    useEffect(() => {
        let live = true;
        setChangelog(undefined);
        void updateChangelogAction()
            .then((answer) => live && setChangelog(answer))
            .catch(() => live && setChangelog(null));
        return () => {
            live = false;
        };
    }, [head]);

    const groups = useMemo(() => groupChangelog(changelog?.entries ?? []), [changelog]);

    const title = <h3 className="text-sm font-medium text-foreground">{t("settings.changelog.title")}</h3>;

    if (changelog === undefined) {
        return (
            <section className="flex flex-col gap-2 border-t border-border pt-3" aria-busy="true">
                {title}
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
            </section>
        );
    }
    if (changelog === null || groups.length === 0) {
        return (
            <section className="flex flex-col gap-1 border-t border-border pt-3">
                {title}
                <p className="text-xs text-muted-foreground">
                    {changelog === null
                        ? t("settings.changelog.unavailable")
                        : t("settings.changelog.nothingVisible")}
                </p>
            </section>
        );
    }

    const repo = changelog.url.replace(/\/compare\/.*$/, "");

    return (
        <section className="flex flex-col gap-2 border-t border-border pt-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                {title}
                <ul className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {groups.map(({ group, entries }) => (
                        <li key={group}>
                            <Badge variant={group === "security" ? "danger" : "neutral"}>
                                {t(`settings.changelog.kinds.${group}`)}
                                <span className="tabular">{entries.length}</span>
                            </Badge>
                        </li>
                    ))}
                </ul>
            </div>

            <div className="flex flex-col divide-y divide-border rounded-md border border-border">
                {groups.map(({ group, entries }) => {
                    const isOpen = expanded[group] ?? OPEN_BY_DEFAULT.has(group);
                    const all = showAll[group] ?? false;
                    const shown = all ? entries : entries.slice(0, FOLDED);
                    const security = group === "security";
                    const listId = `changelog-${group}`;
                    return (
                        <div key={group} className={cn("min-w-0", security && "bg-danger-soft")}>
                            <button
                                type="button"
                                className="flex h-8 w-full min-w-0 items-center gap-1.5 px-2.5 text-left text-[0.6875rem] font-medium uppercase tracking-wide text-foreground-subtle transition-colors duration-fast hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                aria-expanded={isOpen}
                                aria-controls={listId}
                                onClick={() => setExpanded((prev) => ({ ...prev, [group]: !isOpen }))}
                            >
                                <ChevronRight
                                    className={cn(
                                        "size-3.5 shrink-0 transition-transform duration-fast",
                                        isOpen && "rotate-90"
                                    )}
                                    aria-hidden
                                />
                                {security ? (
                                    <ShieldAlert className="size-3.5 shrink-0 text-danger-ink" aria-hidden />
                                ) : null}
                                <span className={cn("min-w-0 truncate", security && "text-danger-ink")}>
                                    {t(`settings.changelog.kinds.${group}`)}
                                </span>
                                <span className="tabular shrink-0">{entries.length}</span>
                            </button>
                            {isOpen ? (
                                <div id={listId} className="pb-1.5">
                                    <ul className={cn("flex flex-col", all && "max-h-72 overflow-y-auto overscroll-contain")}>
                                        {shown.map((entry) => (
                                            <ChangeRow key={entry.sha} entry={entry} repo={repo} />
                                        ))}
                                    </ul>
                                    {entries.length > FOLDED ? (
                                        <button
                                            type="button"
                                            className="ml-3 mt-0.5 sm:ml-8 text-xs text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                            onClick={() => setShowAll((prev) => ({ ...prev, [group]: !all }))}
                                        >
                                            {all
                                                ? t("settings.changelog.showLess")
                                                : t("settings.changelog.showAll", { count: entries.length })}
                                        </button>
                                    ) : null}
                                </div>
                            ) : null}
                        </div>
                    );
                })}
            </div>

            {changelog.more > 0 || changelog.hidden > 0 ? (
                <p className="text-xs text-muted-foreground">
                    {t.rich("settings.changelog.rest", {
                        more: changelog.more,
                        hidden: changelog.hidden,
                        link: (chunks) => (
                            <a
                                key="link"
                                className="text-primary hover:underline"
                                href={changelog.url}
                                target="_blank"
                                rel="noreferrer"
                            >
                                {chunks}
                            </a>
                        )
                    })}
                </p>
            ) : null}
        </section>
    );
}

/** One change on one line: scope, subject (cut, whole in the tooltip), commit. */
function ChangeRow({ entry, repo }: { entry: ChangelogEntry; repo: string }) {
    const t = useTranslations("admin");
    return (
        <li className="flex h-7 min-w-0 items-center gap-2 pl-3 pr-2.5 sm:pl-8 text-[0.8125rem]">
            {entry.security ? (
                <Badge variant={SEVERITY_BADGE[entry.security.severity]}>
                    {t(`settings.security.severity.${entry.security.severity}`)}
                </Badge>
            ) : null}
            {entry.scope ? (
                <span
                    className="max-w-[6rem] shrink-0 truncate sm:max-w-[9rem] rounded bg-muted px-1.5 text-[0.6875rem] leading-[18px] text-muted-foreground"
                    title={entry.scope}
                >
                    {entry.scope}
                </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-foreground" title={entry.title}>
                {entry.title}
            </span>
            <a
                className="shrink-0 font-mono text-[0.6875rem] text-foreground-subtle hover:text-primary hover:underline"
                href={`${repo}/commit/${entry.sha}`}
                target="_blank"
                rel="noreferrer"
                title={t("settings.changelog.openCommit")}
            >
                {entry.sha.slice(0, 7)}
            </a>
        </li>
    );
}
