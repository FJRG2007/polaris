"use client";

/**
 * Who is in here, down the right-hand side.
 *
 * A conversation with more than two people in it is unreadable without this: a
 * name appears, and the only way to find out whether that person is one of four
 * or one of forty is to open a dialog meant for adding somebody. Every chat
 * client with rooms in it has this column and it is not decoration - it is what
 * makes "@everyone" a size you can picture before you press send.
 *
 * The list is the room's roster as the server draws it, which for an open
 * channel is the whole space rather than the handful of people who happen to
 * have a membership row. Anything narrower would be a lie: everybody in the
 * space can read that channel.
 *
 * In a space it is split into who is around and who is not, each by name - see
 * `roster-groups`. A group keeps the order by standing, the owner first: it is a
 * handful of people and the question there is whose group it is. Presence rides
 * on the avatar the same way it does everywhere else in Polaris.
 *
 * Only the rows on screen are drawn, so a space of thousands costs what a space
 * of thirty does once it is loaded.
 *
 * Pressing somebody opens a direct message with them, because that is what
 * clicking a person's name in a room is for.
 */

import * as actions from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useChat } from "./chat-context";
import { Avatar } from "@/components/avatar";
import { useVirtualizer } from "@tanstack/react-virtual";
import Link from "next/link";
import { Crown, Headphones, Users, X } from "lucide-react";
import { useOpenDirect } from "./use-open-direct";
import { useChatStream } from "./use-chat-stream";
import {
    spaceVoiceIds,
    useVoiceRooms,
    voiceSeats,
    VOICE_POLL_MS,
    type VoiceSeat
} from "./voice-rooms";
import { NicknameDialog } from "./nickname-dialog";
import { nameplateCss } from "@/lib/profile-style-css";
import { useKnownPresence, usePresence } from "@/components/presence-store";
import { presenceLine } from "@/components/activity-card";
import { MemberMenu, type MenuPerson } from "./member-menu";
import { useWideScreen, WIDE_ENOUGH } from "./use-wide-screen";
import type { ChatChannelView, ChatMemberView } from "@/lib/chat/chat-service";
import { rosterItems, type ChatRosterMember, type RosterItem } from "@/lib/chat/roster-groups";
import { useChatPane } from "./use-chat-pane";
import { resetPaneLayout } from "./pane-preferences";
import { PersonName, platedRow, usePersonNameplate } from "@/components/person-name";
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type ReactNode
} from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    ResizeHandle,
    Skeleton,
    cn
} from "@polaris/ui";
import { PersonCardProvider } from "./person-card";
import { usePersonPress } from "@/components/person-press";

/**
 * What the members list may be narrowed and widened to.
 *
 * The fallback is the width it has always been drawn at, and the ceiling is well
 * short of the conversation's own: this is a column of names, and every pixel it
 * takes comes off what people are actually reading.
 */
const MEMBERS_PANE = { min: 208, max: 420, fallback: 240 };

/** Where the choice to hide it is kept. Per browser and nothing else: it is a
 *  preference about a screen, not a fact about an account. */
const REMEMBERED = "polaris.chat.members";

/** What a row is assumed to take before it has been measured: a face and a
 *  name, and a heading somewhat less. Measured for real once drawn. */
const ROW_GUESS = 40;
const HEADING_GUESS = 32;

/** The caption beside a name. Members get none: a list where every second line
 *  says "member" is a list nobody reads. Neither does the owner - a crown sits
 *  against their name instead, which is the mark every chat client uses for it
 *  and which reads at a glance in a column of forty. */
const ROLE_WORDS: Record<string, string> = { admin: "Admin" };

interface Roster {
    readonly members: readonly ChatRosterMember[];
    readonly loading: boolean;
}

/**
 * Whether the panel is showing, and the switch that changes it.
 *
 * Open by default on a screen with room for it - that is what a roster is for,
 * and a column you have to ask for every time you open a room is a column
 * nobody uses. Closing it is remembered, so somebody who wants the width keeps
 * it in every conversation and after a reload.
 *
 * Never open by itself on a narrow screen: there the same state opens a dialog
 * over the conversation, and a dialog nobody asked for is not a default.
 */
export function useMembersPanel(): {
    open: boolean;
    setOpen: (open: boolean) => void;
    toggle: () => void;
} {
    const wide = useWideScreen();
    const [open, setShowing] = useState(false);

    useEffect(() => {
        if (!wide) return;
        setShowing(window.localStorage.getItem(REMEMBERED) !== "hidden");
    }, [wide]);

    const setOpen = useCallback((next: boolean) => {
        setShowing(next);
        // Only the deliberate close is written down. A dialog opened on a phone
        // says nothing about whether somebody wants the column on their laptop.
        if (window.matchMedia(WIDE_ENOUGH).matches) {
            window.localStorage.setItem(REMEMBERED, next ? "shown" : "hidden");
        }
    }, []);

    return { open, setOpen, toggle: useCallback(() => setOpen(!open), [open, setOpen]) };
}

/** How long a burst of list changes settles before the roster is read again. */
const ROSTER_SETTLE_MS = 1000;

/**
 * The people in one conversation, kept in step with who joins and leaves.
 *
 * @param showing - Whether anybody is looking. Nothing is fetched for a panel
 *   that is closed: the roster would otherwise be read on every conversation
 *   somebody clicks through, to draw a column that is not there.
 */
function useRoster(channelId: string, ownerId: string | null, showing: boolean): Roster {
    const [members, setMembers] = useState<readonly ChatRosterMember[] | null>(null);

    const load = useCallback(async () => {
        if (!showing) return;
        const result = await actions.listRosterAction(channelId);
        setMembers(result.members ?? []);
    }, [channelId, showing]);

    useEffect(() => {
        setMembers(null);
        void load();
    }, [load]);

    // Somebody joining or leaving is exactly the frame this list exists to
    // follow, and it is the one the rail already listens for.
    const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
        () => () => {
            if (reloadTimer.current) clearTimeout(reloadTimer.current);
            reloadTimer.current = null;
        },
        [load]
    );
    useChatStream(
        useCallback(
            (frame) => {
                if (frame.kind !== "channels" || !showing || reloadTimer.current) return;
                reloadTimer.current = setTimeout(() => {
                    reloadTimer.current = null;
                    void load();
                }, ROSTER_SETTLE_MS);
            },
            [load, showing]
        )
    );

    const owned = useMemo(
        () =>
            (members ?? []).map((member) =>
                // A group has no roles of its own - the one thing there is to say
                // about somebody in one is whether the group is theirs.
                member.userId === ownerId && member.role === "member"
                    ? { ...member, role: "owner" }
                    : member
            ),
        [members, ownerId]
    );

    return { members: owned, loading: members === null };
}

function MemberRows({
    members,
    loading,
    viewerId,
    channel,
    onMention,
    onChanged,
    className
}: {
    members: readonly ChatRosterMember[];
    loading: boolean;
    viewerId: string;
    /** The room being looked at, which is what decides who may do what to whom -
     *  see `MemberMenu`. */
    channel: ChatChannelView;
    onMention: (text: string) => void;
    onChanged: () => void;
    /** The scrolling box's own shape, which differs between the column and the
     *  dialog. */
    className: string;
}) {
    const t = useTranslations("chat");
    const { channels } = useChat();
    const [error, setError] = useState("");
    const direct = useOpenDirect(setError);
    // Who is in a voice room of this space, from the same answer the rail draws
    // its rooms from and only for rooms this reader can reach. Live off the
    // stream, and asked again on the rail's interval so a missed frame does not
    // leave a line wrong; a direct message or a group has no rooms and asks
    // nothing.
    const voiceIds = useMemo(
        () => spaceVoiceIds(channels, channel.spaceId),
        [channels, channel.spaceId]
    );
    const { inRoom } = useVoiceRooms(voiceIds, VOICE_POLL_MS);
    const seats = useMemo(
        () => voiceSeats(channels, channel.spaceId, inRoom),
        [channels, channel.spaceId, inRoom]
    );
    /** Whose nickname is being changed. Held here rather than in the menu: the
     *  menu is unmounted the moment an item is chosen, and a dialog opened by
     *  something that is about to disappear never appears. */
    const [naming, setNaming] = useState<MenuPerson | null>(null);
    // The fresher answer for whoever is drawn; the snapshot the list came with
    // for everybody else.
    const known = useKnownPresence();
    const items = useMemo(
        () => rosterItems(members, known, channel.spaceId !== null),
        [members, known, channel.spaceId]
    );
    const scroller = useRef<HTMLDivElement>(null);
    const rows = useVirtualizer({
        count: items.length,
        getScrollElement: () => scroller.current,
        estimateSize: (index) => (items[index]?.kind === "heading" ? HEADING_GUESS : ROW_GUESS),
        getItemKey: (index) => items[index]?.key ?? index,
        overscan: 8
    });

    if (loading) {
        return (
            <div className={cn("flex flex-col gap-2 p-3", className)} aria-hidden="true">
                {[0, 1, 2, 3].map((row) => (
                    <div key={row} className="flex items-center gap-2">
                        <Skeleton className="size-7 rounded-full" />
                        <Skeleton className="h-3 w-24" />
                    </div>
                ))}
            </div>
        );
    }

    return (
        // Its own card, inside whatever holds the roster: on a narrow screen that
        // is a dialog, and a card opened from outside it would count as a press
        // outside the dialog and close it.
        <PersonCardProvider channelId={channel.id} viewerId={viewerId} onMention={onMention}>
            {error && (
                <p role="alert" className="px-3 pt-2 text-xs text-danger">
                    {error}
                </p>
            )}
            <div ref={scroller} className={cn("overscroll-contain", className)}>
                <ul className="relative m-2" style={{ height: rows.getTotalSize() }}>
                    {rows.getVirtualItems().map((row) => {
                        const item = items[row.index] as RosterItem;
                        return (
                            <li
                                key={row.key}
                                data-index={row.index}
                                ref={rows.measureElement}
                                className="absolute inset-x-0 top-0 pb-0.5"
                                style={{ transform: `translateY(${row.start}px)` }}
                            >
                                {item.kind === "heading" ? (
                                    <h3 className="truncate px-2 pb-1 pt-3 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                                        {item.section === "online"
                                            ? t("members.onlineCount", { count: item.count })
                                            : t("members.offlineCount", { count: item.count })}
                                    </h3>
                                ) : (
                                    <MemberRow
                                        member={item.member}
                                        away={item.away}
                                        voice={seats.get(item.member.userId) ?? null}
                                        you={item.member.userId === viewerId}
                                        channel={channel}
                                        viewerId={viewerId}
                                        busy={direct.busy}
                                        onOpen={() => void direct.open(item.member.userId)}
                                        onMention={onMention}
                                        onNickname={setNaming}
                                        onChanged={onChanged}
                                        onError={setError}
                                    />
                                )}
                            </li>
                        );
                    })}
                </ul>
            </div>

            <NicknameDialog
                open={naming !== null}
                person={naming ? { id: naming.userId, name: naming.name } : null}
                onOpenChange={(open) => !open && setNaming(null)}
                onSaved={onChanged}
            />
        </PersonCardProvider>
    );
}

/** The plate's ink alone, for what sits on a plated row outside its button. */
function plateInk(plate: Parameters<typeof nameplateCss>[0]): CSSProperties {
    const css = nameplateCss(plate) as Record<string, unknown>;
    return {
        ["--plate-ink" as string]: css["--plate-ink"],
        ["--plate-ink-soft" as string]: css["--plate-ink-soft"]
    } as CSSProperties;
}

/**
 * One person in the roster.
 *
 * Its own component because it reads presence, and presence is per person: a
 * hook inside the loop above would be a hook called a different number of times
 * whenever somebody joins the room.
 */
export function MemberRow({
    member,
    away,
    voice,
    you,
    channel,
    viewerId,
    busy,
    onOpen,
    onMention,
    onNickname,
    onChanged,
    onError
}: {
    member: ChatMemberView;
    /** Not around, in a list split by presence: drawn faint, below the people
     *  who could answer now. */
    away: boolean;
    /** The voice room they are sitting in, when the reader can see it. */
    voice: VoiceSeat | null;
    you: boolean;
    channel: ChatChannelView;
    viewerId: string;
    busy: boolean;
    onOpen: () => void;
    onMention: (text: string) => void;
    onNickname: (person: MenuPerson) => void;
    onChanged: () => void;
    onError: (message: string) => void;
}) {
    const t = useTranslations("chat");
    const tc = useTranslations("components");
    const role = ROLE_WORDS[member.role];
    // What they are showing right now. Already on screen for the avatar's dot,
    // so this costs nothing: the store asked about them either way.
    const where = usePresence(member.userId);
    // The line wins over the role when there is one. A role is a fact that does
    // not change; a status is what somebody is doing this afternoon, and two
    // lines under a name in a 14rem column is a wall.
    // What they are doing comes after what they said and before the role, for
    // the same reason: it is this afternoon, and the role is every afternoon.
    // Being in a voice room wins over all of it while it lasts: it is the one
    // thing on this list somebody can act on by walking in.
    const under = presenceLine(where, tc) || role;
    const inVoice = voice ? t("members.inVoiceIn", { channel: voice.channelName }) : "";
    // Asked from the same store the face asked, so it is one request for the
    // panel rather than one per member.
    const plate = usePersonNameplate(member.userId);
    // Pressing somebody in the roster opens their card - yours as well - and the
    // card is where messaging them is.
    const press = usePersonPress();
    return (
        <MemberMenu
            member={member}
            channel={channel}
            viewerId={viewerId}
            onMention={onMention}
            onNickname={onNickname}
            onChanged={onChanged}
            onError={onError}
        >
            <div className="relative" style={plate && voice ? plateInk(plate) : undefined}>
                <button
                    type="button"
                    disabled={press ? false : you || busy}
                    title={
                        press
                            ? t("messageList.viewProfile", { name: member.name })
                            : you
                              ? member.name
                              : t("messageList.messageNamed", { name: member.name })
                    }
                    onClick={(event) =>
                        press
                            ? press({ id: member.userId, name: member.name }, event.currentTarget)
                            : onOpen()
                    }
                    className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
                        you && !press
                            ? "cursor-default"
                            : "hover:bg-card-hover disabled:opacity-70",
                        away && "opacity-50 hover:opacity-100 focus-visible:opacity-100",
                        // A plate replaces the row's own hover tint
                        // rather than being tinted by it.
                        plate && platedRow(plate, "hover:bg-transparent")
                    )}
                    // The plate somebody chose, drawn behind their
                    // whole row - which is where a nameplate goes,
                    // and the only place in a list narrow enough for
                    // a pill around a name to look like a mistake.
                    style={plate ? nameplateCss(plate) : undefined}
                >
                    <Avatar decorated person={{ id: member.userId, name: member.name }} size={28} />
                    <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1">
                            <PersonName
                                id={member.userId}
                                name={member.name}
                                className="truncate text-sm"
                            >
                                {you && (
                                    <span
                                        className={plate ? "opacity-80" : "text-muted-foreground"}
                                    >
                                        {" "}
                                        {t("members.you")}
                                    </span>
                                )}
                            </PersonName>
                            {member.role === "owner" && (
                                <Crown
                                    role="img"
                                    aria-label={t("members.owner")}
                                    className="size-3.5 text-warning"
                                />
                            )}
                        </span>
                        {voice ? (
                            // Room kept for the line drawn over it below: a link
                            // cannot sit inside the row's own button.
                            <span aria-hidden="true" className="invisible block text-[0.6875rem]">
                                {"\u00a0"}
                            </span>
                        ) : (
                            under && (
                                <span
                                    className="block truncate text-[0.6875rem] text-muted-foreground"
                                    title={under}
                                >
                                    {under}
                                </span>
                            )
                        )}
                    </span>
                </button>
                {voice && (
                    // Opens the room rather than walking into it: seeing who is
                    // there is the question, and joining is one press further.
                    <Link
                        href={`/chat/c/${voice.channelId}`}
                        title={inVoice}
                        aria-label={inVoice}
                        className={cn(
                            "absolute bottom-1 left-11 flex max-w-[calc(100%-3.25rem)] min-w-0 items-center gap-1 rounded-sm text-[0.6875rem] text-muted-foreground transition-colors hover:underline",
                            plate ? "hover:text-[var(--plate-ink)]" : "hover:text-foreground",
                            away && "opacity-50"
                        )}
                    >
                        <Headphones aria-hidden="true" className="size-3 shrink-0" />
                        <span className="min-w-0 truncate" title={inVoice}>
                            {t("members.inVoice")}
                        </span>
                    </Link>
                )}
            </div>
        </MemberMenu>
    );
}

/**
 * The roster, as a column beside the conversation or as a dialog over it.
 *
 * Which one is not a preference: a 14rem column beside a 4rem conversation
 * helps nobody, so below the breakpoint where the two fit the same list is a
 * dialog. One component decides it, because it is one question with one answer
 * and two shapes.
 */
export function ChannelMembers({
    channel,
    open,
    onOpenChange,
    onMention,
    search
}: {
    channel: ChatChannelView;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Put somebody into what is being written. The composer owns the box, so
     *  this only says what to drop in it - see `MemberMenu`. */
    onMention: (text: string) => void;
    /** The search box Discord keeps at the top of this column, drawn there
     *  only while the panel is a column - not in the phone's dialog. */
    search?: ReactNode;
}) {
    const t = useTranslations("chat");
    const { viewerId, refresh } = useChat();
    const wide = useWideScreen();
    const { members, loading } = useRoster(channel.id, channel.ownerId, open);
    const heading = loading
        ? t("members.heading")
        : t("members.headingCount", { count: members.length });
    // Above the two early returns below, and deliberately: a hook that only runs
    // on some renders is a crash the first time this panel is closed or drawn on
    // a narrow window.
    const { drawn, ceiling, measure, resize, reset } = useChatPane("members", MEMBERS_PANE);

    if (!open) return null;

    if (!wide) {
        return (
            <Dialog open onOpenChange={onOpenChange}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <Users className="size-4 text-muted-foreground" />
                            {heading}
                        </DialogTitle>
                    </DialogHeader>
                    <MemberRows
                        className="max-h-[60vh] overflow-y-auto overscroll-contain"
                        members={members}
                        loading={loading}
                        viewerId={viewerId}
                        channel={channel}
                        onMention={onMention}
                        onChanged={refresh}
                    />
                </DialogContent>
            </Dialog>
        );
    }

    return (
        // Narrower than the profile beside a direct message by default: this is
        // a list of names, which wraps badly and reads fine narrow, where that
        // one carries sentences. Every pixel it takes comes off the
        // conversation, so where the line sits is left to whoever is reading
        // rather than guessed from the width of the window.
        <>
            <ResizeHandle
                axis="x"
                side="end"
                size={drawn}
                min={MEMBERS_PANE.min}
                max={ceiling}
                onChange={resize}
                onReset={reset}
                onResetAll={resetPaneLayout}
                label={t("members.membersListWidth")}
            />
            <aside
                ref={measure}
                style={{ "--members-pane": `${drawn}px` } as CSSProperties}
                className="flex shrink-0 flex-col border-l border-border w-[var(--members-pane)]"
            >
                {search ? (
                    <div className="flex h-header shrink-0 items-center border-b border-border px-3">
                        {search}
                    </div>
                ) : null}
                <div
                    className={cn(
                        "flex shrink-0 items-center justify-between gap-2 px-3",
                        search ? "pt-3 pb-1" : "h-header border-b border-border"
                    )}
                >
                    <span
                        className={cn(
                            "min-w-0 truncate",
                            search
                                ? "text-xs font-semibold uppercase text-muted-foreground"
                                : "text-sm font-semibold"
                        )}
                    >
                        {heading}
                    </span>
                    <button
                        type="button"
                        aria-label={t("members.hideTheMembers")}
                        onClick={() => onOpenChange(false)}
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <X className="size-4" />
                    </button>
                </div>
                <MemberRows
                    className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
                    members={members}
                    loading={loading}
                    viewerId={viewerId}
                    channel={channel}
                    onMention={onMention}
                    onChanged={refresh}
                />
            </aside>
        </>
    );
}
