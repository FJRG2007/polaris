"use client";

/**
 * Badges on screen: the strip under a name, the detail of one badge, and the
 * "Your badges" dialog that lays out what is earned and what is left.
 *
 * Everything here draws what the server already decided this viewer may see;
 * it never filters on its own.
 */

import { useState } from "react";
import { Lock } from "lucide-react";
import { BadgeIcon } from "./badge-icon";
import type { BadgeView } from "@/lib/badges/badge-service";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

type T = NamespaceTranslator<"badges">;

const CATEGORIES = [
    "staff",
    "custom",
    "tenure",
    "messages",
    "calls",
    "tasks",
    "arcade",
    "servers"
] as const;
const UNITS = ["days", "messages", "minutes", "tasks", "games", "hours"] as const;

type Category = (typeof CATEGORIES)[number];

function categoryOf(badge: BadgeView): Category {
    return (CATEGORIES as readonly string[]).includes(badge.category)
        ? (badge.category as Category)
        : "custom";
}

/** The badge's own name: a custom badge's words, or its category and level. */
export function badgeName(t: T, badge: BadgeView): string {
    if (badge.kind === "custom" && badge.name) return badge.name;
    const category = t(`categories.${categoryOf(badge)}.name`);
    return badge.levelName ? `${category} · ${t(`levels.${badge.levelName}`)}` : category;
}

export function amountOf(t: T, unit: string | null, count: number): string {
    return unit && (UNITS as readonly string[]).includes(unit)
        ? t(`units.${unit as (typeof UNITS)[number]}`, { count })
        : String(count);
}

/** A row of badge icons; each one opens its detail. */
export function BadgeStrip({
    badges,
    className
}: {
    badges: readonly BadgeView[];
    className?: string;
}) {
    const t = useTranslations("badges");
    const [open, setOpen] = useState<BadgeView | null>(null);
    if (badges.length === 0) return null;
    return (
        <>
            <ul
                className={cn("flex flex-wrap items-center gap-1", className)}
                aria-label={t("title")}
            >
                {badges.map((badge) => (
                    <li key={badge.key}>
                        <button
                            type="button"
                            onClick={() => setOpen(badge)}
                            aria-label={t("openBadge", { name: badgeName(t, badge) })}
                            title={badgeName(t, badge)}
                            className="flex rounded-md p-0.5 hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <BadgeIcon
                                icon={badge.icon}
                                kind={badge.kind}
                                level={badge.level}
                                className="size-6"
                            />
                        </button>
                    </li>
                ))}
            </ul>
            {open && (
                <Dialog open onOpenChange={(next) => !next && setOpen(null)}>
                    <DialogContent className="max-w-md">
                        <DialogHeader>
                            <DialogTitle>{badgeName(t, open)}</DialogTitle>
                            <DialogDescription>
                                {t(`categories.${categoryOf(open)}.name`)}
                            </DialogDescription>
                        </DialogHeader>
                        <BadgeDetail badge={open} />
                    </DialogContent>
                </Dialog>
            )}
        </>
    );
}

/** Everything about one badge: what it is, when, how rare, how far, and its ladder. */
export function BadgeDetail({ badge, hidden = false }: { badge: BadgeView; hidden?: boolean }) {
    const t = useTranslations("badges");
    const format = useDisplayFormat();
    const category = categoryOf(badge);
    const description =
        badge.kind === "custom" && badge.description
            ? badge.description
            : t(`categories.${category}.description`);
    return (
        <div className="flex min-w-0 flex-col gap-3">
            <div className="flex min-w-0 items-center gap-3">
                <BadgeIcon
                    icon={badge.icon}
                    kind={badge.kind}
                    level={Math.max(1, badge.level)}
                    locked={!badge.owned}
                    className="size-14"
                />
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={badgeName(t, badge)}>
                        {badgeName(t, badge)}
                    </p>
                    <p className="text-xs text-muted-foreground">{description}</p>
                    {badge.kind === "ladder" && (
                        <p className="text-xs text-muted-foreground">
                            {t("level", { level: badge.level, top: badge.top })}
                        </p>
                    )}
                </div>
            </div>
            <dl className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
                <dd className="text-muted-foreground">
                    {badge.unlockedAt
                        ? t("unlockedOn", { date: format.date(new Date(badge.unlockedAt)) })
                        : t("locked")}
                </dd>
                <dd className="text-muted-foreground">
                    {badge.rarity > 0 ? t("rarity", { percent: badge.rarity }) : t("rarityNone")}
                </dd>
                {hidden && <dd className="text-muted-foreground">{t("hiddenNote")}</dd>}
            </dl>
            {badge.progress && (
                <div className="flex flex-col gap-1">
                    <div
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(badge.progress.fraction * 100)}
                        aria-label={badgeName(t, badge)}
                        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                    >
                        <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${Math.round(badge.progress.fraction * 100)}%` }}
                        />
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {badge.progress.next === null
                            ? t("progressTop")
                            : t("progress", {
                                  value: amountOf(t, badge.unit, badge.progress.value),
                                  next: amountOf(t, badge.unit, badge.progress.next)
                              })}
                    </p>
                </div>
            )}
            {badge.levels.length > 0 && (
                <section className="flex flex-col gap-1">
                    <h3 className="text-[0.6875rem] font-medium uppercase tracking-[0.04em] text-foreground-subtle">
                        {t("ladder")}
                    </h3>
                    <ol className="flex flex-col divide-y divide-border rounded-md border border-border">
                        {badge.levels.map((level) => (
                            <li
                                key={level.level}
                                className="flex min-w-0 items-center gap-2 px-2 py-1.5"
                            >
                                <BadgeIcon
                                    icon={badge.icon}
                                    kind={badge.kind}
                                    level={level.level}
                                    locked={level.unlockedAt === null}
                                    className="size-5"
                                />
                                <span className="min-w-0 flex-1 truncate text-xs">
                                    {t(`levels.${level.name}`)}
                                </span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    {amountOf(t, badge.unit, level.threshold)}
                                </span>
                                {level.unlockedAt ? (
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                        {format.date(new Date(level.unlockedAt))}
                                    </span>
                                ) : (
                                    <Lock
                                        className="size-3.5 shrink-0 text-muted-foreground"
                                        aria-label={t("locked")}
                                    />
                                )}
                            </li>
                        ))}
                    </ol>
                </section>
            )}
        </div>
    );
}

/** The owner's view of every badge: earned, to unlock, and the detail of the picked one. */
export function BadgesDialog({
    shown,
    available,
    hidden = [],
    onClose
}: {
    shown: readonly BadgeView[];
    available: readonly BadgeView[];
    hidden?: readonly string[];
    onClose: () => void;
}) {
    const t = useTranslations("badges");
    const [picked, setPicked] = useState<BadgeView | null>(shown[0] ?? available[0] ?? null);
    const tile = (badge: BadgeView) => (
        <li key={badge.key}>
            <button
                type="button"
                onClick={() => setPicked(badge)}
                aria-pressed={picked?.key === badge.key}
                aria-label={badgeName(t, badge)}
                title={badgeName(t, badge)}
                className={cn(
                    "flex w-full min-w-0 flex-col items-center gap-1 rounded-md p-2 text-center hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    picked?.key === badge.key && "bg-card-hover"
                )}
            >
                <BadgeIcon
                    icon={badge.icon}
                    kind={badge.kind}
                    level={Math.max(1, badge.level)}
                    locked={!badge.owned}
                    className="size-10"
                />
                <span className="w-full truncate text-[0.6875rem]">{badgeName(t, badge)}</span>
            </button>
        </li>
    );
    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <DialogTitle>{t("yourBadges")}</DialogTitle>
                    <DialogDescription>{t("pickOne")}</DialogDescription>
                </DialogHeader>
                <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
                    <div className="flex max-h-[60vh] min-w-0 flex-col gap-3 overflow-y-auto">
                        <section className="flex flex-col gap-1">
                            <h3 className="text-[0.6875rem] font-medium uppercase tracking-[0.04em] text-foreground-subtle">
                                {t("owned")}
                            </h3>
                            {shown.length === 0 ? (
                                <p className="text-xs text-muted-foreground">{t("noneOwned")}</p>
                            ) : (
                                <ul className="grid grid-cols-3 gap-1 sm:grid-cols-4">
                                    {shown.map(tile)}
                                </ul>
                            )}
                        </section>
                        <section className="flex flex-col gap-1">
                            <h3 className="text-[0.6875rem] font-medium uppercase tracking-[0.04em] text-foreground-subtle">
                                {t("available")}
                            </h3>
                            {available.length === 0 ? (
                                <p className="text-xs text-muted-foreground">{t("allOwned")}</p>
                            ) : (
                                <ul className="grid grid-cols-3 gap-1 sm:grid-cols-4">
                                    {available.map(tile)}
                                </ul>
                            )}
                        </section>
                    </div>
                    <div className="min-w-0 border-t border-border pt-3 md:border-l md:border-t-0 md:pl-4 md:pt-0">
                        {picked ? (
                            <BadgeDetail badge={picked} hidden={hidden.includes(picked.key)} />
                        ) : (
                            <p className="text-xs text-muted-foreground">{t("pickOne")}</p>
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
