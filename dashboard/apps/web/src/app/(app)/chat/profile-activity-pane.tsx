"use client";

/**
 * The right half of a person's larger profile, as Discord lays it out: tabs for
 * what they are doing, the friends you have in common and the spaces you share.
 *
 * Only what Polaris keeps. "Current activity" is the card their presence
 * already carries - read from the presence store, counted on this screen's
 * clock, through their privacy settings on the server. "Recent activity" is
 * what the profile read brought back (`recentActivityFor`): visits to game
 * servers here and games played together, never anything guessed.
 *
 * The tab row and the current card draw at once; only the recent list waits on
 * the profile read, behind a skeleton the shape of its rows. A tab for things in
 * common appears once there is something in common to list.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { Gamepad2, Pickaxe } from "lucide-react";
import { GameLogo } from "@/components/game-logo";
import type { ChatProfile } from "@/lib/chat/profiles";
import { usePresence } from "@/components/presence-store";
import { RelativeTime } from "@/components/relative-time";
import { FriendRows, SpaceRows, type MutualTab } from "./profile-details";
import { ActivityCards } from "@/components/activity-card";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { EmptyState, SegmentedControl, Skeleton } from "@polaris/ui";
import type { RecentActivityView } from "@/lib/presence-activity/recent";

type Tab = "activity" | MutualTab;

export function ProfileActivityPane({
    personId,
    name,
    profile,
    loading,
    initialTab = "activity",
    messageAction
}: {
    personId: string;
    /** What they are called here, for the line said when there is nothing. */
    name: string;
    profile: ChatProfile | null;
    loading: boolean;
    /** The tab it opens on - a count in the column opens its own list. */
    initialTab?: Tab;
    /** The way to talk to them, offered when there is nothing to show. */
    messageAction?: React.ReactNode;
}) {
    const t = useTranslations("chat");
    const [tab, setTab] = useState<Tab>(initialTab);
    // Nothing in common is never a tab, and neither is anything a reader
    // outside the profile audience was not told.
    const mutual = profile && !profile.restricted ? profile.mutual : null;
    const friends = mutual?.friends.total ? mutual.friends : null;
    const spaces = mutual?.spaces.total ? mutual.spaces : null;
    const shown: Tab =
        (tab === "friends" && !friends) || (tab === "spaces" && !spaces) ? "activity" : tab;

    const options = [
        { value: "activity" as const, label: t("profilePane.activity") },
        ...(friends
            ? [
                  {
                      value: "friends" as const,
                      label: t("profileDetails.mutualFriends", { count: friends.total })
                  }
              ]
            : []),
        ...(spaces
            ? [
                  {
                      value: "spaces" as const,
                      label: t("profileDetails.mutualServers", { count: spaces.total })
                  }
              ]
            : [])
    ];

    return (
        // The dialog keeps one size, as Discord's does: the tabs stay put and
        // only the list under them scrolls, so switching tabs never resizes it.
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
            <SegmentedControl
                aria-label={t("profilePane.sections")}
                value={shown}
                onValueChange={setTab}
                options={options}
                size="sm"
                // Clear of the dialog's close in the corner, without pushing
                // everything under the tabs off centre.
                className="shrink-0 self-start max-w-full overflow-x-auto md:max-w-[calc(100%-2.75rem)]"
            />
            <div className="min-h-0 min-w-0 flex-1 md:overflow-y-auto md:overscroll-contain">
                {shown === "activity" ? (
                    <ActivityTab
                        personId={personId}
                        name={name}
                        profile={profile}
                        loading={loading}
                        messageAction={messageAction}
                    />
                ) : shown === "friends" && friends ? (
                    <MutualList more={friends.total - friends.people.length}>
                        <FriendRows people={friends.people} />
                    </MutualList>
                ) : spaces ? (
                    <MutualList more={spaces.total - spaces.spaces.length}>
                        <SpaceRows spaces={spaces.spaces} />
                    </MutualList>
                ) : null}
            </div>
        </div>
    );
}

function ActivityTab({
    personId,
    name,
    profile,
    loading,
    messageAction
}: {
    personId: string;
    name: string;
    profile: ChatProfile | null;
    loading: boolean;
    messageAction?: React.ReactNode;
}) {
    const t = useTranslations("chat");
    const current = usePresence(personId)?.activity ?? [];
    const recent = profile?.recent ?? [];
    const waiting = loading && !profile;

    if (!waiting && current.length === 0 && recent.length === 0) {
        return (
            // As Discord says it: who has nothing to share, and a way to start
            // something instead of a dead end.
            <EmptyState
                bare
                className="py-10"
                title={t("profilePane.emptyTitle", { name })}
                description={t("profilePane.emptyHint")}
                action={messageAction}
            />
        );
    }

    return (
        <div className="flex min-w-0 flex-col gap-4">
            {current.length > 0 ? (
                <section className="flex min-w-0 flex-col gap-2">
                    <Heading>{t("profilePane.current")}</Heading>
                    <ActivityCards personId={personId} />
                </section>
            ) : null}
            {waiting ? (
                <section className="flex min-w-0 flex-col gap-2" aria-busy>
                    <Heading>{t("profilePane.recent")}</Heading>
                    {[0, 1].map((index) => (
                        <div
                            key={index}
                            className="flex items-center gap-3 rounded-lg bg-muted/40 p-3"
                        >
                            <Skeleton className="size-12 shrink-0 rounded-md" />
                            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                                <Skeleton className="h-3.5 w-32" />
                                <Skeleton className="h-3 w-20" />
                            </div>
                        </div>
                    ))}
                </section>
            ) : recent.length > 0 ? (
                <section className="flex min-w-0 flex-col gap-2">
                    <Heading>{t("profilePane.recent")}</Heading>
                    <ul className="flex min-w-0 flex-col gap-2">
                        {recent.map((entry) => (
                            <RecentRow key={entry.key} entry={entry} />
                        ))}
                    </ul>
                </section>
            ) : null}
        </div>
    );
}

function Heading({ children }: { children: React.ReactNode }) {
    return (
        <h3 className="text-[0.6875rem] font-medium uppercase tracking-[0.04em] text-foreground-subtle">
            {children}
        </h3>
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

/** A tab's list of things in common, and how many it leaves out. */
function MutualList({ more, children }: { more: number; children: React.ReactNode }) {
    const t = useTranslations("chat");
    return (
        <div className="flex min-w-0 flex-col">
            <ul className="flex min-w-0 flex-col gap-0.5">{children}</ul>
            {more > 0 ? (
                <p className="px-1.5 pt-1 text-xs text-muted-foreground">
                    {t("profileDetails.andMore", { count: more })}
                </p>
            ) : null}
        </div>
    );
}
