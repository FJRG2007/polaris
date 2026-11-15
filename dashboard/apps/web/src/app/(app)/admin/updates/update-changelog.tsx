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

import { installedChangelogAction, updateChangelogAction } from "./actions";
import { AppLogo, Badge, Skeleton, cn, hasAppLogo } from "@polaris/ui";
import type { ChangelogEntry } from "@polaris/core";
import { useEffect, useMemo, useRef, useState } from "react";
import {
    ArrowRight,
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

/** Which range a changelog describes: the update on offer, or the one the
 *  running build was installed by. */
export type ChangelogKind = "available" | "installed";

/** One range as the screen draws it; `from` null when it is not known. */
interface RangeRead {
    readonly from: string | null;
    readonly changelog: Changelog | null;
}

/** Ranges read in this tab, so coming back paints the last answer at once
 *  while a fresh one is asked for behind it. */
const readRanges = new Map<string, RangeRead>();
const STORE_PREFIX = "polaris.updates.changelog.";

function rememberedRange(key: string): RangeRead | undefined {
    const known = readRanges.get(key);
    if (known) return known;
    try {
        const raw = window.sessionStorage.getItem(STORE_PREFIX + key);
        if (!raw) return undefined;
        const parsed = JSON.parse(raw) as RangeRead;
        readRanges.set(key, parsed);
        return parsed;
    } catch {
        return undefined;
    }
}

function rememberRange(key: string, value: RangeRead): void {
    readRanges.set(key, value);
    try {
        window.sessionStorage.setItem(STORE_PREFIX + key, JSON.stringify(value));
    } catch {
        // Storage full or blocked: the copy in memory still serves this tab.
    }
}

async function loadRange(kind: ChangelogKind): Promise<RangeRead> {
    if (kind === "installed") {
        const installed = await installedChangelogAction();
        return { from: installed.from, changelog: installed.changelog };
    }
    const changelog = await updateChangelogAction();
    return { from: changelog?.base ?? null, changelog };
}

/**
 * What a range of builds carries. `head` is the build the range ends at: the
 * published one for the update on offer, the running one for the update
 * installed - so the two ranges meet at the running build and never overlap.
 */
export function UpdateChangelog({
    head,
    kind = "available",
    base = null
}: {
    head: string;
    kind?: ChangelogKind;
    /** The build the range starts at, when the caller already knows it. */
    base?: string | null;
}) {
    const t = useTranslations("admin");
    const key = `${kind}:${head}`;
    const [read, setRead] = useState<RangeRead | null | undefined>(() =>
        typeof window === "undefined" ? undefined : rememberedRange(key)
    );
    const changelog = read === undefined ? undefined : (read?.changelog ?? null);
    const [expanded, setExpanded] = useState<Partial<Record<ChangelogGroup, boolean>>>({});
    const [showAll, setShowAll] = useState<Partial<Record<ChangelogGroup, boolean>>>({});
    const section = useRef<HTMLElement | null>(null);
    // What is already installed matters less than what is on offer: it starts
    // folded, and is read only once opened - unless the "updated" notice sent
    // the reader here for it.
    const [folded, setFolded] = useState(kind === "installed");
    useEffect(() => {
        if (kind !== "installed") return;
        const follow = () => window.location.hash === "#installed" && setFolded(false);
        follow();
        window.addEventListener("hashchange", follow);
        return () => window.removeEventListener("hashchange", follow);
    }, [kind]);

    useEffect(() => {
        if (folded) return;
        let live = true;
        // The last answer for this range stays on screen while it is asked again.
        setRead(rememberedRange(key));
        void loadRange(kind)
            .then((answer) => {
                if (!live) return;
                rememberRange(key, answer);
                setRead(answer);
            })
            .catch(() => live && setRead((current) => current ?? null));
        return () => {
            live = false;
        };
    }, [key, kind, folded]);

    // Opened from the "updated" notice: bring this range into view once drawn.
    const drawn = read !== undefined;
    useEffect(() => {
        if (kind !== "installed" || !drawn) return;
        if (window.location.hash === "#installed") section.current?.scrollIntoView?.({ block: "start" });
    }, [kind, drawn]);
    const groups = useMemo(() => groupChangelog(changelog?.entries ?? []), [changelog]);
    // The website, desktop and extension ship on their own: counted with the
    // rest that is not listed, never shown as something this update installs.
    const elsewhere = useMemo(
        () => (changelog?.entries ?? []).filter(shipsElsewhere).length,
        [changelog]
    );

    const installed = kind === "installed";
    const from = read?.from ?? base;
    const foldId = `changelog-${kind}-body`;
    const sectionProps = {
        ref: section,
        id: installed ? "installed" : undefined,
        "aria-label": installed ? t("settings.changelog.installedTitle") : t("settings.changelog.title")
    };
    const title = (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <h3 className="text-sm font-medium text-foreground">
                {installed ? t("settings.changelog.installedTitle") : t("settings.changelog.title")}
            </h3>
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                {installed ? t("settings.changelog.installedLabel") : t("settings.changelog.availableLabel")}
                {from ? (
                    <>
                        <span className="font-mono">{from.slice(0, 7)}</span>
                        <ArrowRight className="size-3 shrink-0" aria-label={t("settings.changelog.to")} />
                    </>
                ) : null}
                <span className="font-mono">{head.slice(0, 7)}</span>
            </span>
        </div>
    );

    const fold = installed ? (
        <button
            type="button"
            className="flex min-w-0 items-center gap-1.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={!folded}
            aria-controls={foldId}
            onClick={() => setFolded((value) => !value)}
        >
            <ChevronRight
                className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-fast", !folded && "rotate-90")}
                aria-hidden
            />
            {title}
        </button>
    ) : (
        title
    );

    if (folded) {
        return (
            <section {...sectionProps} className="flex flex-col gap-1 border-t border-border pt-3">
                {fold}
            </section>
        );
    }

    if (read === undefined) {
        return (
            <section {...sectionProps} className="flex flex-col gap-2 border-t border-border pt-3" aria-busy="true">
                {fold}
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
            </section>
        );
    }
    if (!changelog || groups.length === 0) {
        return (
            <section {...sectionProps} className="flex flex-col gap-1 border-t border-border pt-3">
                {fold}
                <p className="text-xs text-muted-foreground">
                    {installed && !read?.from
                        ? t("settings.changelog.installedUnknown")
                        : !changelog
                          ? installed
                              ? t("settings.changelog.installedUnavailable")
                              : t("settings.changelog.unavailable")
                          : t("settings.changelog.nothingVisible")}
                </p>
            </section>
        );
    }

    const repo = changelog.url.replace(/\/compare\/.*$/, "");

    return (
        <section {...sectionProps} className="flex flex-col gap-2 border-t border-border pt-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                {fold}
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

            {installed ? null : (
                <p className="text-xs text-muted-foreground">{t("settings.changelog.availableHint")}</p>
            )}

            <div className="flex flex-col divide-y divide-border rounded-md border border-border">
                {groups.map(({ group, entries }) => {
                    const isOpen = expanded[group] ?? OPEN_BY_DEFAULT.has(group);
                    const all = showAll[group] ?? false;
                    const shown = all ? entries : entries.slice(0, FOLDED);
                    const security = group === "security";
                    const listId = `changelog-${kind}-${group}`;
                    const Icon = GROUP_ICONS[group];
                    return (
                        <div key={group} className={cn("min-w-0", security && "bg-danger-soft")}>
                            <button
                                type="button"
                                className="flex h-8 w-full min-w-0 items-center gap-1.5 px-2.5 text-start text-[0.6875rem] font-medium uppercase tracking-wide text-foreground-subtle transition-colors duration-fast hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                                            className="ms-3 mt-0.5 sm:ms-8 text-xs text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        <li className="flex h-7 min-w-0 items-center gap-2 ps-3 pe-2.5 sm:ps-8 text-[0.8125rem]">
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
