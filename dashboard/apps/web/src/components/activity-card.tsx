"use client";

/**
 * What somebody is doing, drawn beside their presence.
 *
 * Two sizes. The card is Discord's: a small heading saying what kind of thing it
 * is, the art on the left, three lines of what it is, and how long it has been
 * going - a bar for a track, which has an end, and a count for a game, which does
 * not. The line is what a row has room for: an icon and "Playing Hollow Knight".
 *
 * Both read the presence store, which already asked about everybody on screen
 * for their dot, so drawing one costs no request. What arrives there has been
 * through the person's privacy settings on the server; nothing here decides who
 * may see what.
 *
 * Elapsed time is counted on this screen's clock from the start the server
 * gave, so a card keeps counting without asking again. It only ticks while a
 * card is mounted, and once a second only on a card that shows seconds.
 */

import { cn } from "@polaris/ui";
import * as core from "@polaris/core";
import type { ReactNode } from "react";
import { useNow } from "@/components/presence";
import { Gamepad2, Music, Pickaxe } from "lucide-react";
import { usePresence, type PresenceOf } from "@/components/presence-store";

/** The icon a source is drawn with where there is no art. */
const SOURCE_ICONS: Record<core.ActivitySource, typeof Gamepad2> = {
    spotify: Music,
    game: Gamepad2,
    minecraft: Pickaxe
};

/** The small heading over a card. */
function heading(activity: core.ActivityView): string {
    if (activity.source === "spotify") return "Listening to Spotify";
    if (activity.source === "minecraft") return "Playing on a server here";
    return "Playing";
}

/**
 * The line a row shows under a name: what they said, if they said anything, and
 * otherwise what they are doing. A status is a sentence somebody chose to put
 * there, so it wins over a fact a machine observed.
 */
export function presenceLine(where: PresenceOf | null | undefined): string {
    const said = where?.note?.trim();
    if (said) return said;
    const first = where?.activity?.[0];
    return first ? core.activityShortLine(first) : "";
}

/** What one person is doing, as one short line with its icon. Nothing when
 *  they are doing nothing that this reader may be told. */
export function ActivityLine({
    personId,
    className
}: {
    personId: string | null | undefined;
    className?: string;
}) {
    const first = usePresence(personId)?.activity?.[0];
    if (!first) return null;
    const Icon = SOURCE_ICONS[first.source];
    const line = core.activityShortLine(first);
    return (
        <span
            className={cn(
                "flex min-w-0 items-center gap-1 text-xs text-muted-foreground",
                className
            )}
            title={line}
        >
            <Icon className="size-3 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">{line}</span>
        </span>
    );
}

/**
 * Every activity one person has, as cards. Nothing at all when there are none,
 * so a profile never grows an empty box.
 *
 * `actions` draws under a card - the "Listen along" button under a track. It is
 * handed the activity so the caller decides which ones get what.
 */
export function ActivityCards({
    personId,
    className,
    actions
}: {
    personId: string | null | undefined;
    className?: string;
    actions?: (activity: core.ActivityView) => ReactNode;
}) {
    const activity = usePresence(personId)?.activity ?? [];
    if (activity.length === 0) return null;
    return (
        <div className={cn("flex w-full flex-col gap-2", className)}>
            {activity.map((one) => (
                <ActivityCard
                    key={`${one.source}:${one.key}`}
                    activity={one}
                    actions={actions?.(one)}
                />
            ))}
        </div>
    );
}

export function ActivityCard({
    activity,
    actions
}: {
    activity: core.ActivityView;
    actions?: ReactNode;
}) {
    const Icon = SOURCE_ICONS[activity.source];
    return (
        <section
            aria-label={core.activityShortLine(activity)}
            className="w-full rounded-md bg-muted/40 px-3 py-2.5 text-left"
        >
            <p className="text-[0.6875rem] font-medium uppercase tracking-[0.04em] text-foreground-subtle">
                {heading(activity)}
            </p>
            <div className="mt-2 flex items-center gap-3">
                <span className="relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                    {activity.imageUrl ? (
                        // A picture from the music service's own CDN, at the size
                        // it was handed: there is no second copy to optimize.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                            src={activity.imageUrl}
                            alt=""
                            className="size-full object-cover"
                            referrerPolicy="no-referrer"
                        />
                    ) : (
                        <Icon className="size-6 text-muted-foreground" aria-hidden />
                    )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs">
                    {activity.linkUrl ? (
                        <a
                            href={activity.linkUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="truncate font-semibold text-foreground hover:underline"
                            title={activity.name}
                        >
                            {activity.name}
                        </a>
                    ) : (
                        <span
                            className="truncate font-semibold text-foreground"
                            title={activity.name}
                        >
                            {activity.name}
                        </span>
                    )}
                    {activity.details ? (
                        <span className="truncate text-muted-foreground" title={activity.details}>
                            {activity.source === "spotify"
                                ? `by ${activity.details}`
                                : activity.details}
                        </span>
                    ) : null}
                    {activity.state ? (
                        <span className="truncate text-muted-foreground" title={activity.state}>
                            {activity.source === "spotify"
                                ? `on ${activity.state}`
                                : activity.state}
                        </span>
                    ) : null}
                    {activity.endsAt ? null : <Elapsed startedAt={activity.startedAt} />}
                </span>
            </div>
            {activity.endsAt ? <TrackBar activity={activity} /> : null}
            {actions ? <div className="mt-2 flex flex-wrap gap-2">{actions}</div> : null}
        </section>
    );
}

/** How long a game has been going, counted here. Once a second, because it
 *  shows seconds; a card is only ever a few of these on a screen. */
function Elapsed({ startedAt }: { startedAt: string }) {
    const now = useNow(1_000);
    const start = Date.parse(startedAt);
    if (!Number.isFinite(start)) return null;
    return (
        <span className="tabular-nums text-muted-foreground">
            {core.formatElapsed(now - start)} elapsed
        </span>
    );
}

/** A track's position, as a bar with the two times under it. */
function TrackBar({ activity }: { activity: core.ActivityView }) {
    const now = useNow(1_000);
    const progress = core.trackProgress(activity, now);
    if (!progress) return null;
    const share = progress.totalMs > 0 ? (progress.elapsedMs / progress.totalMs) * 100 : 0;
    return (
        <div className="mt-2">
            <div
                className="h-1 w-full overflow-hidden rounded-full bg-border"
                role="progressbar"
                aria-label="Track position"
                aria-valuemin={0}
                aria-valuemax={Math.round(progress.totalMs / 1000)}
                aria-valuenow={Math.round(progress.elapsedMs / 1000)}
            >
                <div className="h-full rounded-full bg-foreground" style={{ width: `${share}%` }} />
            </div>
            <div className="mt-1 flex justify-between text-[0.6875rem] tabular-nums text-muted-foreground">
                <span>{core.formatElapsed(progress.elapsedMs)}</span>
                <span>{core.formatElapsed(progress.totalMs)}</span>
            </div>
        </div>
    );
}
