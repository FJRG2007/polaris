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
import { AppLogo, Badge, Skeleton, cn, hasAppLogo } from "@polaris/ui";
import type { ChangelogEntry } from "@polaris/core";
import { useEffect, useMemo, useState } from "react";
import {
    Bug,
    ChevronRight,
    Gauge,
    Package,
    ShieldAlert,
    Sparkles,
    Wrench,
    type LucideIcon
} from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { UpdateChangelog as Changelog } from "@/lib/update-changelog";
import { groupChangelog, shipsElsewhere, type ChangelogGroup } from "@/lib/changelog-groups";

/** Rows shown per group before "Show all". */
const FOLDED = 4;

/** Groups open on arrival; the rest wait for a click. */
const OPEN_BY_DEFAULT: ReadonlySet<ChangelogGroup> = new Set(["security", "feature"]);

/** Each group's mark, beside its name in the summary and on its header. */
const GROUP_ICONS: Record<ChangelogGroup, LucideIcon> = {
    security: ShieldAlert,
    feature: Sparkles,
    fix: Bug,
    performance: Gauge,
    other: Package,
    maintenance: Wrench
};

/** Scopes named differently from the app whose logo they stand for. */
const SCOPE_APPS: Readonly<Record<string, string>> = {
    agents: "polar",
    places: "home",
    "game-servers": "games",
    servers: "cloud-servers",
    "network-filter": "dns-blocker",
    updates: "admin",
    users: "admin"
};

/** The app logo a commit scope stands for, or null to show the scope as text. */
export function scopeApp(scope: string): string | null {
    const app = SCOPE_APPS[scope] ?? scope;
    return hasAppLogo(app) ? app : null;
}

/** Scopes that are initialisms, written in capitals when shown as text. */
const SCOPE_INITIALISMS: ReadonlySet<string> = new Set([
    "ai",
    "api",
    "ci",
    "cli",
    "css",
    "dns",
    "ip",
    "mcp",
    "pdf",
    "ssh",
    "sso",
    "tv",
    "ui",
    "usb",
    "vpn"
]);

/**
 * A commit subject as a line of the changelog. Subjects are written in lower
 * case by the commit convention; read as a list, they start with a capital.
 */
export function changeTitle(title: string): string {
    return title.charAt(0).toLocaleUpperCase("en") + title.slice(1);
}

/** A commit scope as a label: `agents` reads "Agents", `ui` reads "UI",
 *  `game-servers` reads "Game servers", and each of `a,b` the same way. */
export function scopeLabel(scope: string): string {
    return scope
        .split(",")
        .map((part) => {
            const word = part.trim();
            if (SCOPE_INITIALISMS.has(word)) return word.toUpperCase();
            return changeTitle(word.replace(/-/g, " "));
        })
        .join(", ");
}

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
    // The website, desktop and extension ship on their own: counted with the
    // rest that is not listed, never shown as something this update installs.
    const elsewhere = useMemo(
        () => (changelog?.entries ?? []).filter(shipsElsewhere).length,
        [changelog]
    );

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
                    {groups.map(({ group, entries }) => {
                        const Icon = GROUP_ICONS[group];
                        return (
                            <li key={group}>
                                <Badge variant={group === "security" ? "danger" : "neutral"}>
                                    <Icon className="size-3 shrink-0" aria-hidden />
                                    {t(`settings.changelog.kinds.${group}`)}
                                    <span className="tabular">{entries.length}</span>
                                </Badge>
                            </li>
                        );
                    })}
                </ul>
            </div>

            <div className="flex flex-col divide-y divide-border rounded-md border border-border">
                {groups.map(({ group, entries }) => {
                    const isOpen = expanded[group] ?? OPEN_BY_DEFAULT.has(group);
                    const all = showAll[group] ?? false;
                    const shown = all ? entries : entries.slice(0, FOLDED);
                    const security = group === "security";
                    const listId = `changelog-${group}`;
                    const Icon = GROUP_ICONS[group];
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
                                <Icon
                                    className={cn("size-3.5 shrink-0", security && "text-danger-ink")}
                                    aria-hidden
                                />
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

            {changelog.more > 0 || changelog.hidden + elsewhere > 0 ? (
                <p className="text-xs text-muted-foreground">
                    {t.rich("settings.changelog.rest", {
                        more: changelog.more,
                        hidden: changelog.hidden + elsewhere,
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
            {entry.scope && scopeApp(entry.scope) ? (
                <span className="flex shrink-0" title={scopeLabel(entry.scope)}>
                    <AppLogo appId={scopeApp(entry.scope)!} size={16} />
                    <span className="sr-only">{scopeLabel(entry.scope)}</span>
                </span>
            ) : entry.scope ? (
                <span
                    className="max-w-[6rem] shrink-0 truncate sm:max-w-[9rem] rounded bg-muted px-1.5 text-[0.6875rem] leading-[18px] text-muted-foreground"
                    title={scopeLabel(entry.scope)}
                >
                    {scopeLabel(entry.scope)}
                </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-foreground" title={changeTitle(entry.title)}>
                {changeTitle(entry.title)}
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
