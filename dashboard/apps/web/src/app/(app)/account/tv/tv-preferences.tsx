"use client";

/**
 * What a TV's owner can change from here, usually on the phone that scanned the
 * TV's QR: its name, Block ads and trackers, and whether its lookups reach the
 * Network filter. The TV applies the switch on its next check-in and says how it
 * went, so the line under the switch tells "asked" apart from "done".
 */

import { Check, Pencil, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { TvRow } from "@/lib/tv/update-requests";
import type { TvFilterReach } from "@/lib/tv/filter-reach";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Badge, Button, Input, Skeleton, Switch } from "@polaris/ui";
import type { TvBlockingReport } from "@/lib/tv/preferences";
import { TV_NAME_MAX, tvNameSchema } from "@/lib/tv/tv-name";
import { tvTakesBlocking } from "@/lib/tv/version-order";

/** Where Block ads and trackers stands on one TV, for the line under its switch. */
export type TvBlockingStatus =
    | "updateFirst"
    | "notAsked"
    | "waiting"
    | "on"
    | "off"
    | Exclude<TvBlockingReport, "on" | "off">;

/** What the switch shows: what was asked, or failing that what the TV said. */
export function blockingSwitchOn(row: TvRow): boolean {
    return row.blocking.desired ?? row.blocking.applied === "on";
}

/**
 * `applied` is always the TV's answer to the latest choice (a new choice clears
 * it), so anything there is how that choice went.
 */
export function blockingStatus(row: TvRow): TvBlockingStatus {
    const { desired, applied } = row.blocking;
    if (!tvTakesBlocking(row.versionCode)) return "updateFirst";
    if (desired === null) return applied === "on" ? "on" : applied ? "off" : "notAsked";
    if (applied === null) return "waiting";
    if (applied === "on") return "on";
    if (applied === "off" || (!desired && applied === "left-as-set")) return "off";
    // The TV said why it could not.
    return applied;
}

/** Whether the TV still has to act on what was asked; the list refreshes until it has. */
export function blockingWaiting(row: TvRow): boolean {
    return blockingStatus(row) === "waiting";
}

const STATUS_WORDS = {
    updateFirst: "tv.prefs.status.updateFirst",
    notAsked: "tv.prefs.status.notAsked",
    waiting: "tv.prefs.status.waiting",
    on: "tv.prefs.status.on",
    off: "tv.prefs.status.off",
    failed: "tv.prefs.status.failed",
    unavailable: "tv.prefs.status.unavailable",
    "no-permission": "tv.prefs.status.noPermission",
    "no-filter": "tv.prefs.status.noFilter",
    "left-as-set": "tv.prefs.status.leftAsSet"
} as const satisfies Record<TvBlockingStatus, `tv.prefs.status.${string}`>;

const REACH_WORDS = {
    reaching: "tv.prefs.reach.reaching",
    notReaching: "tv.prefs.reach.notReaching",
    filterOff: "tv.prefs.reach.filterOff",
    unknown: "tv.prefs.reach.unknown"
} as const satisfies Record<TvFilterReach, `tv.prefs.reach.${string}`>;

const REACH_TONE = {
    reaching: "success",
    notReaching: "warning",
    filterOff: "neutral",
    unknown: "neutral"
} as const satisfies Record<TvFilterReach, "success" | "warning" | "neutral">;

export function TvPreferences({
    row,
    reach,
    onBlocking
}: {
    row: TvRow;
    /** Undefined while the filter is being asked. */
    reach: TvFilterReach | undefined;
    onBlocking: (next: boolean) => void;
}) {
    const t = useTranslations("account");
    const status = blockingStatus(row);
    const problem = !["updateFirst", "notAsked", "waiting", "on", "off"].includes(status);
    const statusId = `tv-blocking-${row.id}`;
    return (
        <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex min-w-0 items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">{t("tv.prefs.blocking")}</span>
                    <span
                        id={statusId}
                        className={
                            problem
                                ? "text-xs text-warning-ink"
                                : "truncate text-xs text-muted-foreground"
                        }
                    >
                        {t(STATUS_WORDS[status])}
                    </span>
                </div>
                <Switch
                    checked={blockingSwitchOn(row)}
                    disabled={status === "updateFirst"}
                    onChange={onBlocking}
                    aria-label={t("tv.prefs.blocking")}
                    aria-describedby={statusId}
                />
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
                {reach === undefined ? (
                    <Skeleton className="h-5 w-40" aria-hidden />
                ) : (
                    <Badge
                        variant={REACH_TONE[reach]}
                        className="min-w-0 truncate"
                        title={
                            reach === "notReaching" && row.address
                                ? t("tv.prefs.reach.notReachingHint", { address: row.address })
                                : undefined
                        }
                    >
                        {t(REACH_WORDS[reach])}
                    </Badge>
                )}
            </div>
        </div>
    );
}

/** The TV's name, with a pencil that turns it into a field. */
export function TvName({
    row,
    onRename
}: {
    row: TvRow;
    onRename: (name: string) => Promise<boolean>;
}) {
    const t = useTranslations("account");
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(row.name);
    const [saving, setSaving] = useState(false);
    const parsed = tvNameSchema.safeParse(draft);
    const unchanged = parsed.success && parsed.data === row.name;
    const tooLong = draft.trim().length > TV_NAME_MAX;

    async function save(event: FormEvent) {
        event.preventDefault();
        if (!parsed.success || unchanged || saving) return;
        setSaving(true);
        const done = await onRename(parsed.data);
        setSaving(false);
        if (done) setEditing(false);
    }

    if (!editing) {
        return (
            <span className="flex min-w-0 items-center gap-1">
                <span className="truncate text-sm font-medium" title={row.name}>
                    {row.name}
                </span>
                <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("tv.prefs.rename")}
                    title={t("tv.prefs.rename")}
                    onClick={() => {
                        setDraft(row.name);
                        setEditing(true);
                    }}
                >
                    <Pencil aria-hidden />
                </Button>
            </span>
        );
    }
    return (
        <form className="flex min-w-0 items-center gap-1" onSubmit={(event) => void save(event)}>
            <Input
                autoFocus
                value={draft}
                maxLength={TV_NAME_MAX + 20}
                aria-label={t("tv.prefs.nameLabel")}
                aria-invalid={tooLong || undefined}
                title={tooLong ? t("tv.prefs.errors.badName") : undefined}
                className="h-7 min-w-0 flex-1"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Escape") setEditing(false);
                }}
            />
            <Button
                type="submit"
                size="icon-sm"
                variant="ghost"
                aria-label={t("tv.prefs.save")}
                title={t("tv.prefs.save")}
                aria-disabled={!parsed.success || unchanged || saving}
                disabled={saving}
            >
                <Check aria-hidden />
            </Button>
            <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t("tv.prefs.cancel")}
                title={t("tv.prefs.cancel")}
                onClick={() => setEditing(false)}
            >
                <X aria-hidden />
            </Button>
        </form>
    );
}
