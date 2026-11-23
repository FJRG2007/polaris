"use client";

/**
 * The sections a profile is read in, drawn once.
 *
 * Two screens show a person: the profile in chat (`ProfileDetails` and the
 * larger view's `ProfileActivityPane`) and their own page, `/u/<username>`.
 * They used to draw these pieces each in their own way, which is how the page
 * came to show less than the card. Both draw from here now, so a section added
 * to one is a section the other has too. Each takes its heading already worded,
 * because the two screens read their words from different tables.
 */

import { cn } from "@polaris/ui";
import * as core from "@polaris/core";
import { useState, type ReactNode } from "react";
import { Gamepad2, Pickaxe } from "lucide-react";
import { GameLogo } from "@/components/game-logo";
import { RelativeTime } from "@/components/relative-time";
import { useLocale } from "@/components/i18n/i18n-provider";
import type { RecentActivityView } from "@/lib/presence-activity/recent";

/** The small heading over a section of a profile. */
export function ProfileSectionHeading({ children }: { children: ReactNode }) {
    return (
        <h3 className="text-[0.6875rem] font-medium uppercase tracking-[0.04em] text-foreground-subtle">
            {children}
        </h3>
    );
}

/** A date under a small heading: when they joined, when you became friends. In
 *  the reader's language. */
export function SinceRow({ label, iso, large }: { label: string; iso: string; large: boolean }) {
    const locale = useLocale();
    return (
        <div className="w-full text-start">
            <ProfileSectionHeading>{label}</ProfileSectionHeading>
            <p className={cn("mt-1 text-muted-foreground", large ? "text-sm" : "text-xs")}>
                {new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso))}
            </p>
        </div>
    );
}

/** What they did lately, under its heading. Nothing at all when there is none. */
export function RecentActivityList({
    heading,
    recent
}: {
    heading: string;
    recent: readonly RecentActivityView[];
}) {
    if (recent.length === 0) return null;
    return (
        <section className="flex min-w-0 flex-col gap-2">
            <ProfileSectionHeading>{heading}</ProfileSectionHeading>
            <ul className="flex min-w-0 flex-col gap-2">
                {recent.map((entry) => (
                    <RecentRow key={entry.key} entry={entry} />
                ))}
            </ul>
        </section>
    );
}

/** One thing they did lately: the game's mark or the server's picture, what it
 *  was, where, and how long ago it ended. */
function RecentRow({ entry }: { entry: RecentActivityView }) {
    const game = entry.gameId ? (core.findGame(entry.gameId) ?? null) : null;
    const Icon = entry.source === "minecraft" ? Pickaxe : Gamepad2;
    // A picture that did not load - a server with no icon, one since removed -
    // falls back to the game's mark rather than a broken image.
    const [broken, setBroken] = useState(false);
    const picture = entry.imageUrl && !broken ? entry.imageUrl : null;
    return (
        <li className="flex min-w-0 items-center gap-3 rounded-lg bg-muted/40 p-3">
            <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                {picture ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a small icon the dashboard serves itself
                    <img
                        src={picture}
                        alt=""
                        aria-hidden
                        className="size-full object-cover [image-rendering:pixelated]"
                        onError={() => setBroken(true)}
                    />
                ) : game ? (
                    <GameLogo game={game} className="size-9" />
                ) : (
                    <Icon aria-hidden className="size-6 shrink-0 text-muted-foreground" />
                )}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium" title={entry.name}>
                    {entry.name}
                </span>
                {entry.details ? (
                    <span className="truncate text-xs text-muted-foreground" title={entry.details}>
                        {entry.details}
                    </span>
                ) : null}
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Gamepad2 aria-hidden className="size-3 shrink-0" />
                    <RelativeTime iso={entry.endedAt} formatStyle="narrow" />
                </span>
            </span>
        </li>
    );
}
