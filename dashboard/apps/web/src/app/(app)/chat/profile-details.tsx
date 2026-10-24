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
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { AtSign, ChevronRight, Lock } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Avatar } from "@/components/avatar";
import { Badge, cn, Skeleton } from "@polaris/ui";
import { PersonName } from "@/components/person-name";
import { ProfileLink } from "@/components/profile-link";
import { useRouter } from "next/navigation";
import { useChat } from "./chat-context";
import type { ChatProfile } from "@/lib/chat/profiles";
import { MutualPanel } from "@/components/mutual-panel";
import { usePresence } from "@/components/presence-store";
import { ActivityCards } from "@/components/activity-card";
import { ProfileBanner } from "@/components/profile-banner";
import * as polls from "./chat-reads";

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
        void polls
            .chatProfile(channelId, userId)
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
    actions,
    onAvatar,
    bannerActions,
    footer
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
    /** Pressing the face opens their full profile - the card's way in, as in
     *  Discord, rather than a button of its own. Without it the face opens
     *  their picture. */
    onAvatar?: () => void;
    /** Buttons laid over the band's top right corner, Discord's place for them. */
    bannerActions?: ReactNode;
    /** What closes the profile off at the bottom - the column's way to the
     *  larger view. */
    footer?: ReactNode;
}) {
    const t = useTranslations("chat");
    const where = usePresence(person.id);
    const name = profile?.name || person.name;
    const full = size === "full";
    const panel = size === "panel";
    const locale = useLocale();

    return (
        <div className="flex flex-col">
            <div className="relative shrink-0">
                <ProfileBanner
                    person={{ id: person.id, name }}
                    className={cn("shrink-0", full ? "h-28" : panel ? "h-24" : "h-16")}
                />
                {bannerActions ? (
                    <div className="absolute right-2 top-2 flex items-center gap-1">
                        {bannerActions}
                    </div>
                ) : null}
            </div>

            <div className={cn("flex flex-col gap-3 pb-4", full ? "px-5" : "px-4")}>
                {/* Cut out of the band's lower edge, on the left, where a profile
                    puts a face. The ring is the surface's own background rather
                    than a border: it is the cut-out, not a decoration. The dot
                    rides on the face here as it does everywhere else. */}
                <div className={full ? "-mt-12" : "-mt-8"}>
                    {onAvatar ? (
                        <button
                            type="button"
                            onClick={onAvatar}
                            aria-label={t("personCard.viewFullProfile")}
                            title={t("personCard.viewFullProfile")}
                            className="rounded-full transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <Avatar
                                decorated
                                person={{ id: person.id, name }}
                                size={full ? 96 : 72}
                                className="ring-[3px] ring-background"
                            />
                        </button>
                    ) : (
                        <Avatar
                            openable
                            decorated
                            person={{ id: person.id, name }}
                            size={full ? 96 : 72}
                            className="ring-[3px] ring-background"
                        />
                    )}
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
                        <p
                            className="truncate text-xs text-muted-foreground"
                            title={profile.fullName}
                        >
                            {profile.fullName}
                        </p>
                    )}
                    {profile?.headline ? (
                        <p className="mt-1 break-words text-xs text-foreground/90">
                            {profile.headline}
                        </p>
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

                {/* What they are playing or listening to, when they share it
                    with this reader - under what they said, which is theirs and
                    wins the top spot. */}
                <ActivityCards personId={person.id} />

                {/* What the two of them have in common, from the same module the
                    profile page draws it from. Not on the card: a glance is the
                    name, the face and what they said, and this is the part of a
                    profile somebody reads when they have sat down with it. */}
                {panel && profile?.mutual && !profile.restricted ? (
                    <MutualSections mutual={profile.mutual} />
                ) : null}
                {full && profile?.mutual && !profile.restricted ? (
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
                            {t("profileDetails.about")}
                        </p>
                        {panel ? (
                            <ClampedBio text={profile.description} />
                        ) : (
                            <p
                                className={cn(
                                    "mt-1 whitespace-pre-wrap break-words text-muted-foreground",
                                    full ? "text-sm" : "text-xs",
                                    // A card is a glance; the whole of it is one
                                    // press away in the larger view.
                                    size === "card" && "line-clamp-4"
                                )}
                            >
                                {profile.description}
                            </p>
                        )}
                    </div>
                )}

                {size !== "card" && profile?.memberSince ? (
                    <div className="w-full text-left">
                        <p className="text-[0.6875rem] font-medium uppercase tracking-[0.04em] text-foreground-subtle">
                            {t("profileDetails.memberSince")}
                        </p>
                        <p
                            className={cn(
                                "mt-1 text-muted-foreground",
                                full ? "text-sm" : "text-xs"
                            )}
                        >
                            {new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
                                new Date(profile.memberSince)
                            )}
                        </p>
                    </div>
                ) : null}

                {profile?.restricted ? (
                    <p className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground">
                        <Lock className="size-3.5 shrink-0" />
                        {t("profileDetails.restricted")}
                    </p>
                ) : null}

                {footer}
            </div>
        </div>
    );
}

/** How many lines of a bio the column shows before offering the rest. */
const BIO_LINES = 6;

/**
 * What they wrote, cut to a few lines in the column, with the way to the rest
 * only when something was actually cut. Measured after drawing rather than
 * guessed from a character count: a short bio of long lines and a long one of
 * short lines wrap nothing alike.
 */
export function ClampedBio({ text }: { text: string }) {
    const t = useTranslations("chat");
    const box = useRef<HTMLParagraphElement>(null);
    const [whole, setWhole] = useState(false);
    const [cut, setCut] = useState(false);

    useLayoutEffect(() => {
        const element = box.current;
        if (!element || whole) return;
        const measure = () => setCut(element.scrollHeight > element.clientHeight + 1);
        measure();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [text, whole]);

    return (
        <>
            <p
                ref={box}
                className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground"
                style={
                    whole
                        ? undefined
                        : {
                              display: "-webkit-box",
                              WebkitBoxOrient: "vertical",
                              WebkitLineClamp: BIO_LINES,
                              overflow: "hidden"
                          }
                }
            >
                {text}
            </p>
            {cut || whole ? (
                <button
                    type="button"
                    onClick={() => setWhole((current) => !current)}
                    className="mt-1 text-xs font-medium text-primary hover:underline"
                >
                    {whole ? t("profileDetails.showLess") : t("profileDetails.viewFullBio")}
                </button>
            ) : null}
        </>
    );
}

/** The two halves of what you have in common, as the column draws them. */
type Shared = ChatProfile["mutual"];

/**
 * Discord's two rows under a profile: "3 mutual friends", "2 mutual servers",
 * each a count that opens into the list. Collapsed to begin with - the count is
 * the fact; the names are for whoever asks. Each person goes to their page and
 * each space opens in the chat. Nothing is drawn for a half with nobody in it.
 */
export function MutualSections({ mutual }: { mutual: Shared }) {
    const t = useTranslations("chat");
    const router = useRouter();
    const { channels, setActiveSpaceId } = useChat();
    if (mutual.friends.total === 0 && mutual.spaces.total === 0) return null;

    /** A space opens where its first channel is, the way picking it on the
     *  rail does. */
    const openSpace = (spaceId: string) => {
        setActiveSpaceId(spaceId);
        const first = channels.find(
            (channel) =>
                channel.spaceId === spaceId && !channel.archived && channel.kind !== "voice"
        );
        router.push(first ? `/chat/c/${first.id}` : "/chat");
    };

    return (
        <div className="flex w-full flex-col gap-1 border-t border-border pt-3">
            {mutual.friends.total > 0 ? (
                <Section
                    label={t("profileDetails.mutualFriends", { count: mutual.friends.total })}
                    more={mutual.friends.total - mutual.friends.people.length}
                >
                    {mutual.friends.people.map((person) => (
                        <li key={person.id}>
                            <ProfileLink
                                href={`/u/${person.username}`}
                                className="flex min-w-0 items-center gap-2 rounded px-1.5 py-1 text-sm transition-colors hover:bg-muted"
                            >
                                <Avatar person={person} size={20} />
                                <span className="min-w-0 flex-1 truncate" title={person.name}>
                                    <PersonName id={person.id} name={person.name} />
                                </span>
                            </ProfileLink>
                        </li>
                    ))}
                </Section>
            ) : null}
            {mutual.spaces.total > 0 ? (
                <Section
                    label={t("profileDetails.mutualServers", { count: mutual.spaces.total })}
                    more={mutual.spaces.total - mutual.spaces.spaces.length}
                >
                    {mutual.spaces.spaces.map((space) => (
                        <li key={space.id}>
                            <button
                                type="button"
                                onClick={() => openSpace(space.id)}
                                className="flex w-full min-w-0 items-center gap-2 rounded px-1.5 py-1 text-left text-sm transition-colors hover:bg-muted"
                            >
                                <span
                                    aria-hidden
                                    className="size-2 shrink-0 rounded-full"
                                    style={{ background: space.color }}
                                />
                                <span className="min-w-0 flex-1 truncate" title={space.name}>
                                    {space.name}
                                </span>
                            </button>
                        </li>
                    ))}
                </Section>
            ) : null}
        </div>
    );
}

/** One collapsible count and the list under it. */
function Section({
    label,
    more,
    children
}: {
    label: string;
    /** How many the list leaves out, said under it when it is any. */
    more: number;
    children: ReactNode;
}) {
    const t = useTranslations("chat");
    const [open, setOpen] = useState(false);
    return (
        <div className="flex flex-col">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((current) => !current)}
                className="flex min-w-0 items-center justify-between gap-2 rounded px-1.5 py-1.5 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
                <span className="min-w-0 truncate">{label}</span>
                <ChevronRight
                    aria-hidden
                    className={cn(
                        "size-3.5 shrink-0 text-muted-foreground transition-transform",
                        open && "rotate-90"
                    )}
                />
            </button>
            {open ? (
                <>
                    <ul className="flex flex-col gap-0.5 pb-1">{children}</ul>
                    {more > 0 ? (
                        <p className="px-1.5 pb-1 text-xs text-muted-foreground">
                            {t("profileDetails.andMore", { count: more })}
                        </p>
                    ) : null}
                </>
            ) : null}
        </div>
    );
}
