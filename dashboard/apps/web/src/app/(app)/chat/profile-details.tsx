"use client";

/**
 * A person, drawn as a profile.
 *
 * One drawing for every place a person is looked at in chat - the column beside
 * a direct message, the card a pressed name opens, and the larger view that card
 * expands into. They are the same profile at three sizes, and three drawings is
 * how the three come to disagree about what somebody said about themselves.
 *
 * The shape is Discord's: a band across the top, the face cut out of its lower
 * edge on the left, and everything about them reading down from there. Almost
 * nobody uploads a banner, so the band is a colour taken from their own face -
 * see `ProfileBanner`.
 *
 * What it shows is what the server decided this reader may be told (see
 * `chatProfile`), and nothing is drawn for a field that came back empty: the
 * name on the account is only there for a reader its owner allows, and an empty
 * line would say "hidden" louder than leaving it out.
 */

import Link from "next/link";
import { AtSign } from "lucide-react";
import { profileAction } from "./actions";
import { useEffect, useState } from "react";
import { Avatar } from "@/components/avatar";
import { Badge, cn, Skeleton } from "@polaris/ui";
import { PersonName } from "@/components/person-name";
import type { ChatProfile } from "@/lib/chat/profiles";
import { MutualPanel } from "@/components/mutual-panel";
import { usePresence } from "@/components/presence-store";
import { ProfileBanner } from "@/components/profile-banner";

/** Somebody, as far as the screen already knows them. */
export interface ProfilePerson {
    readonly id: string;
    readonly name: string;
}

/**
 * Their profile, asked for inside the conversation it is being read in.
 *
 * The conversation is not context here, it is the permission: an action that
 * resolved a bare id into somebody's handle would be a directory of the whole
 * instance. See `chatProfile`.
 */
export function useChatProfile(
    channelId: string,
    userId: string | null
): { profile: ChatProfile | null; loading: boolean } {
    const [profile, setProfile] = useState<ChatProfile | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!userId) {
            setProfile(null);
            return;
        }
        let live = true;
        setLoading(true);
        setProfile(null);
        void profileAction(channelId, userId)
            .then((result) => {
                if (live) setProfile(result.profile ?? null);
            })
            .catch(() => undefined)
            .finally(() => {
                if (live) setLoading(false);
            });
        return () => {
            live = false;
        };
    }, [channelId, userId]);

    return { profile, loading };
}

/** How big it is drawn. The column and the card are the same size; the expanded
 *  view is the one with room. */
export type ProfileSize = "panel" | "card" | "full";

export function ProfileDetails({
    person,
    profile,
    loading,
    size = "panel",
    role,
    actions
}: {
    person: ProfilePerson;
    profile: ChatProfile | null;
    loading: boolean;
    size?: ProfileSize;
    /** What they are in the place this was opened from, already worded - the
     *  caller knows whether that place is a space or a group. */
    role?: string | null;
    /** What can be done about them, drawn under their name. */
    actions?: React.ReactNode;
}) {
    const where = usePresence(person.id);
    const name = profile?.name || person.name;
    const full = size === "full";

    return (
        <div className="flex flex-col">
            <ProfileBanner
                person={{ id: person.id, name }}
                className={cn("shrink-0", full ? "h-28" : "h-16")}
            />

            <div className={cn("flex flex-col gap-3 pb-4", full ? "px-5" : "px-4")}>
                {/* Cut out of the band's lower edge, on the left, where a profile
                    puts a face. The ring is the surface's own background rather
                    than a border: it is the cut-out, not a decoration. The dot
                    rides on the face here as it does everywhere else. */}
                <div className={full ? "-mt-12" : "-mt-8"}>
                    <Avatar
                        openable
                        decorated
                        person={{ id: person.id, name }}
                        size={full ? 96 : 72}
                        className="ring-[3px] ring-background"
                    />
                </div>

                <div className="flex min-w-0 flex-col gap-0.5">
                    <p
                        className={cn(
                            "flex min-w-0 flex-wrap items-baseline gap-x-1.5 font-medium",
                            full ? "text-lg" : "text-sm"
                        )}
                        title={name}
                    >
                        <span className="min-w-0 truncate">
                            <PersonName id={person.id} name={name} />
                        </span>
                        {/* Beside the name, because that is what it is about -
                            and only when they have said. */}
                        {profile?.pronouns ? (
                            <span className="text-xs font-normal text-muted-foreground">
                                {profile.pronouns}
                            </span>
                        ) : null}
                    </p>
                    {loading && !profile ? (
                        <Skeleton className="h-3 w-24" />
                    ) : (
                        profile?.username && (
                            // The handle is the address of their own page, so it
                            // is the way to it.
                            <Link
                                href={`/u/${profile.username}`}
                                className="flex items-center gap-0.5 truncate text-xs text-muted-foreground hover:text-foreground hover:underline"
                            >
                                <AtSign className="size-3 shrink-0" />
                                {profile.username}
                            </Link>
                        )
                    )}
                    {/* Their name, when it is not already what they are called
                        here and they allow this reader to see it. */}
                    {profile?.fullName && profile.fullName !== name && (
                        <p className="truncate text-xs text-muted-foreground" title={profile.fullName}>
                            {profile.fullName}
                        </p>
                    )}
                    {profile?.headline ? (
                        <p className="mt-1 break-words text-xs text-foreground/90">{profile.headline}</p>
                    ) : null}
                    {role ? (
                        <span className="mt-1.5">
                            <Badge variant="neutral">{role}</Badge>
                        </span>
                    ) : null}
                </div>

                {actions}

                {/* What they are showing, and only that. Where they are is
                    already on the face above; the note is what this person chose
                    to say, and only there while they are here. */}
                {where?.note && (
                    <p className="w-full whitespace-pre-wrap break-words rounded-md bg-muted/40 px-3 py-2 text-xs text-foreground">
                        {where.note}
                    </p>
                )}

                {/* What the two of them have in common, from the same module the
                    profile page draws it from. Not on the card: a glance is the
                    name, the face and what they said, and this is the part of a
                    profile somebody reads when they have sat down with it. */}
                {size !== "card" && profile?.mutual ? (
                    <div className="w-full text-left">
                        <MutualPanel
                            compact={!full}
                            friends={profile.mutual.friends}
                            spaces={profile.mutual.spaces}
                        />
                    </div>
                ) : null}

                {profile?.description && (
                    <div className="w-full text-left">
                        <p className="text-[0.6875rem] font-medium uppercase tracking-[0.04em] text-foreground-subtle">
                            About
                        </p>
                        <p
                            className={cn(
                                "mt-1 whitespace-pre-wrap break-words text-muted-foreground",
                                full ? "text-sm" : "text-xs",
                                // A card is a glance; the whole of it is one press
                                // away in the larger view.
                                size === "card" && "line-clamp-4"
                            )}
                        >
                            {profile.description}
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}
