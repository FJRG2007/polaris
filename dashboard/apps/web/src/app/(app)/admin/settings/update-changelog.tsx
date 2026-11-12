"use client";

/**
 * What the update on offer carries, grouped the way somebody deciding whether
 * to install reads it: security fixes first, with their severity, then what is
 * new, what was fixed, and what got faster. Read from the commits
 * (`lib/update-changelog`), so it is there for every build without anybody
 * writing release notes; past what the screen lists, the rest is a count and a
 * link to the full comparison.
 */

import { ChevronDown } from "lucide-react";
import { updateChangelogAction } from "./actions";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, Skeleton, cn } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { UpdateChangelog as Changelog } from "@/lib/update-changelog";
import { CHANGE_KINDS, type ChangeKind, type ChangelogEntry } from "@polaris/core";

/** Entries shown per group before "Show all". */
const FOLDED = 8;

const SEVERITY_BADGE = {
    critical: "danger",
    high: "danger",
    medium: "warning",
    low: "neutral"
} as const;

export function UpdateChangelog({ head }: { head: string }) {
    const t = useTranslations("admin");
    const [changelog, setChangelog] = useState<Changelog | null | undefined>(undefined);
    const [open, setOpen] = useState<Partial<Record<ChangeKind, boolean>>>({});

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

    const groups = useMemo(() => {
        const byKind = new Map<ChangeKind, ChangelogEntry[]>();
        for (const entry of changelog?.entries ?? []) {
            byKind.set(entry.kind, [...(byKind.get(entry.kind) ?? []), entry]);
        }
        return CHANGE_KINDS.flatMap((kind) => {
            const entries = byKind.get(kind);
            return entries ? [{ kind, entries }] : [];
        });
    }, [changelog]);

    if (changelog === undefined) {
        return (
            <div className="flex flex-col gap-2" aria-busy="true">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
                <Skeleton className="h-3 w-2/3" />
            </div>
        );
    }
    if (changelog === null) {
        return <p className="text-xs text-muted-foreground">{t("settings.changelog.unavailable")}</p>;
    }
    if (groups.length === 0) {
        return <p className="text-xs text-muted-foreground">{t("settings.changelog.nothingVisible")}</p>;
    }

    return (
        <div className="flex flex-col gap-3">
            <p className="text-sm font-medium text-foreground">{t("settings.changelog.title")}</p>
            {groups.map(({ kind, entries }) => {
                const shown = open[kind] ? entries : entries.slice(0, FOLDED);
                return (
                    <section key={kind} className="flex flex-col gap-1">
                        <h3 className="text-xs font-medium text-foreground">
                            {t(`settings.changelog.kinds.${kind}`)}{" "}
                            <span className="text-muted-foreground">({entries.length})</span>
                        </h3>
                        <ul className="flex flex-col gap-1">
                            {shown.map((entry) => (
                                <li key={entry.sha} className="flex min-w-0 items-start gap-2">
                                    {entry.security ? (
                                        <Badge variant={SEVERITY_BADGE[entry.security.severity]}>
                                            {t(`settings.security.severity.${entry.security.severity}`)}
                                        </Badge>
                                    ) : null}
                                    {entry.scope ? <Badge>{entry.scope}</Badge> : null}
                                    <span className="min-w-0 flex-1 break-words text-foreground">
                                        {entry.title}
                                    </span>
                                    <a
                                        className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground hover:text-primary hover:underline"
                                        href={`${changelog.url.replace(/\/compare\/.*$/, "")}/commit/${entry.sha}`}
                                        target="_blank"
                                        rel="noreferrer"
                                        title={t("settings.changelog.openCommit")}
                                    >
                                        {entry.sha.slice(0, 7)}
                                    </a>
                                </li>
                            ))}
                        </ul>
                        {entries.length > FOLDED ? (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="self-start"
                                onClick={() => setOpen((prev) => ({ ...prev, [kind]: !prev[kind] }))}
                            >
                                <ChevronDown
                                    className={cn("size-3.5 transition-transform", open[kind] && "rotate-180")}
                                    aria-hidden
                                />
                                {open[kind]
                                    ? t("settings.changelog.showLess")
                                    : t("settings.changelog.showAll", { count: entries.length })}
                            </Button>
                        ) : null}
                    </section>
                );
            })}
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
        </div>
    );
}
