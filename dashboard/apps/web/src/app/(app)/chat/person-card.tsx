"use client";

/**
 * Pressing somebody opens a card about them.
 *
 * Their name on a message, their face beside it, an @mention of them, their row
 * in the roster: all four are the same person and all four open the same card,
 * beside whatever was pressed - the face, the name, the handle, what they are in
 * this space, what they wrote about themselves, and the button to message them.
 * From the card the profile opens larger, and from there their own page.
 *
 * It used to be that pressing a name went straight to a direct message with that
 * person. That is one of the things somebody might want, and the card still has
 * it one press away; the card is what everything else was missing, and it is how
 * every chat client people already use answers "who is this".
 *
 * Right-clicking a name still opens the person menu (see `MemberMenu`), and the
 * card carries the same menu behind its three dots.
 *
 * What the card shows is exactly what the column beside a direct message shows,
 * from the same request and the same privacy decisions - see `chatProfile` and
 * `ProfileDetails`.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useChat } from "./chat-context";
import { placeCard } from "./card-placement";
import { useOpenDirect } from "./use-open-direct";
import { NicknameDialog } from "./nickname-dialog";
import type { ChatRole } from "@/lib/chat/profiles";
import { MemberMenu, type MenuPerson } from "./member-menu";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import { PersonPressContext, type PersonPress } from "@/components/person-press";
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ProfileDetails, useChatProfile, type ProfilePerson } from "./profile-details";
import { Button, Dialog, DialogContent, DialogFloating, DialogTitle } from "@polaris/ui";
import { ArrowUpRight, Maximize2, MessageSquare, MoreHorizontal, Pencil } from "lucide-react";

/** Somebody pressed, and what they were pressed on. */
interface Opened {
    readonly person: ProfilePerson;
    readonly anchor: HTMLElement;
}

/**
 * Makes every person drawn inside it open their card when pressed.
 *
 * Put around whatever draws people - the conversation, a thread, the roster - so
 * the card belongs to the place it was opened from: that decides which
 * conversation the profile is asked through, what "their role here" means, and
 * where a mention chosen from the card's menu is written. Inside a dialog it has
 * to be inside that dialog as well, or a press on the card counts as a press
 * outside the dialog and closes it.
 */
export function PersonCardProvider({
    channelId,
    viewerId,
    onMention,
    children
}: {
    channelId: string;
    viewerId: string;
    /** Put them into what is being written, from the card's menu. Absent where
     *  there is no box, and then the menu does not offer it. */
    onMention?: (text: string) => void;
    children: ReactNode;
}) {
    const [opened, setOpened] = useState<Opened | null>(null);
    const [expanded, setExpanded] = useState<ProfilePerson | null>(null);
    /** Held here rather than in the card's menu: the menu is unmounted the moment
     *  an item is chosen, and a dialog opened by something about to disappear
     *  never appears. */
    const [naming, setNaming] = useState<MenuPerson | null>(null);

    // Pressing the same name again closes its card, the way a toggle does.
    const press = useCallback<PersonPress>((person, anchor) => {
        setOpened((current) =>
            current && current.person.id === person.id && current.anchor === anchor
                ? null
                : { person, anchor }
        );
    }, []);

    return (
        <PersonPressContext.Provider value={press}>
            {children}
            {opened && (
                <PersonCard
                    // A card is about one person: pressing somebody else starts
                    // a new one rather than morphing this one's contents.
                    key={opened.person.id}
                    person={opened.person}
                    anchor={opened.anchor}
                    channelId={channelId}
                    viewerId={viewerId}
                    onMention={onMention}
                    onNickname={setNaming}
                    onClose={() => setOpened(null)}
                    onExpand={() => {
                        setExpanded(opened.person);
                        setOpened(null);
                    }}
                />
            )}
            {expanded && (
                <PersonProfileDialog
                    person={expanded}
                    channelId={channelId}
                    viewerId={viewerId}
                    onMention={onMention}
                    onNickname={setNaming}
                    onClose={() => setExpanded(null)}
                />
            )}
            <NicknameDialog
                open={naming !== null}
                person={naming ? { id: naming.userId, name: naming.name } : null}
                onOpenChange={(open) => !open && setNaming(null)}
                onSaved={() => setNaming(null)}
            />
        </PersonPressContext.Provider>
    );
}

/** Their role here, in words, or null when they have none. */
function roleWords(role: ChatRole | null | undefined, channel: ChatChannelView | undefined): string | null {
    if (!role) return null;
    if (!channel?.spaceId) return role === "owner" ? "Group owner" : null;
    return role === "owner" ? "Space owner" : "Space admin";
}

/**
 * What can be done about them from the card and from the larger view.
 *
 * Message them, unless this already is the conversation with them. The person
 * menu behind the three dots - the same one a right-click on their name opens.
 * And for your own card, the way to change what it says.
 */
function PersonActions({
    person,
    channel,
    viewerId,
    onMention,
    onNickname,
    onDone,
    extra
}: {
    person: ProfilePerson;
    channel: ChatChannelView | undefined;
    viewerId: string;
    onMention?: (text: string) => void;
    onNickname: (person: MenuPerson) => void;
    /** Something was chosen that takes the reader elsewhere. */
    onDone: () => void;
    extra?: ReactNode;
}) {
    const { refresh } = useChat();
    const router = useRouter();
    const [error, setError] = useState("");
    const direct = useOpenDirect(setError);
    const self = person.id === viewerId;
    const here = channel?.kind === "dm" && channel.others.some((other) => other.id === person.id);

    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
                {self ? (
                    <Button asChild size="sm" variant="secondary">
                        <Link href="/account" onClick={onDone}>
                            <Pencil className="size-4" />
                            Edit profile
                        </Link>
                    </Button>
                ) : here ? null : (
                    <Button
                        size="sm"
                        disabled={direct.busy}
                        // Closed only once the conversation is there to go to: a
                        // refusal is said here, on the card, not lost with it.
                        onClick={() =>
                            void direct.open(person.id, (id) => {
                                onDone();
                                router.push(`/chat/c/${id}`);
                            })
                        }
                    >
                        <MessageSquare className="size-4" />
                        Message
                    </Button>
                )}
                {extra}
                {!self && channel && (
                    <MemberMenu
                        member={{ userId: person.id, name: person.name }}
                        channel={channel}
                        viewerId={viewerId}
                        openWith="press"
                        onMention={onMention}
                        onNickname={onNickname}
                        onChanged={refresh}
                        onError={setError}
                    >
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`What you can do about ${person.name}`}
                            title="More"
                        >
                            <MoreHorizontal className="size-4" />
                        </Button>
                    </MemberMenu>
                )}
            </div>
            {error && (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            )}
        </div>
    );
}

/** The card itself, beside what was pressed. */
function PersonCard({
    person,
    anchor,
    channelId,
    viewerId,
    onMention,
    onNickname,
    onClose,
    onExpand
}: {
    person: ProfilePerson;
    anchor: HTMLElement;
    channelId: string;
    viewerId: string;
    onMention?: (text: string) => void;
    onNickname: (person: MenuPerson) => void;
    onClose: () => void;
    onExpand: () => void;
}) {
    const { channels } = useChat();
    const channel = channels.find((entry) => entry.id === channelId);
    const { profile, loading } = useChatProfile(channelId, person.id);
    /** The card's element, as state: it is drawn into a portal a render after
     *  this one, and placing it has to wait until it is there. */
    const [surface, setSurface] = useState<HTMLDivElement | null>(null);
    const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
    /** Whether closing was the keyboard's doing, which is the one case where the
     *  focus goes back to what was pressed. A press somewhere else put the focus
     *  where it was pressed, and taking it back would undo that. */
    const byKey = useRef(false);

    // Placed once it has a size, and again whenever that changes - the profile
    // arriving makes it taller, and a card that grew off the bottom of the window
    // would hide its buttons.
    useLayoutEffect(() => {
        if (!surface) return;
        const measure = () =>
            setPlace(
                placeCard(
                    anchor.getBoundingClientRect(),
                    { width: surface.offsetWidth, height: surface.offsetHeight },
                    { width: window.innerWidth, height: window.innerHeight }
                )
            );
        measure();
        window.addEventListener("resize", measure);
        const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
        observer?.observe(surface);
        return () => {
            window.removeEventListener("resize", measure);
            observer?.disconnect();
        };
    }, [anchor, surface]);

    return (
        <Dialog open modal={false} onOpenChange={(open) => !open && onClose()}>
            <DialogFloating
                ref={setSurface}
                aria-describedby={undefined}
                tabIndex={-1}
                style={{
                    left: place?.left ?? 0,
                    top: place?.top ?? 0,
                    // Drawn only once it knows where it goes, so it never flashes
                    // in the corner first. Transparent rather than hidden: a
                    // hidden element cannot take the focus it is given on opening.
                    opacity: place ? undefined : 0
                }}
                className="max-h-[calc(100dvh-1rem)] w-72 p-0"
                // The card takes the focus itself rather than its first button,
                // so Escape works at once and no button looks chosen.
                onOpenAutoFocus={(event) => {
                    event.preventDefault();
                    // The event is fired on the card as it mounts, before the
                    // element has reached the ref.
                    if (event.target instanceof HTMLElement) event.target.focus();
                }}
                onEscapeKeyDown={() => {
                    byKey.current = true;
                }}
                onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    if (byKey.current && anchor.isConnected) anchor.focus();
                }}
                // A press on what opened it is the toggle closing it, not a
                // press somewhere else - see `PersonCardProvider`.
                onInteractOutside={(event) => {
                    if (event.target instanceof Node && anchor.contains(event.target)) event.preventDefault();
                }}
            >
                <DialogTitle className="sr-only">{profile?.name || person.name}</DialogTitle>
                <div className="relative">
                    <button
                        type="button"
                        onClick={onExpand}
                        aria-label="View full profile"
                        title="View full profile"
                        className="absolute right-2 top-2 z-10 rounded-md bg-black/35 p-1.5 text-white transition-colors hover:bg-black/55"
                    >
                        <Maximize2 className="size-3.5" />
                    </button>
                    <ProfileDetails
                        size="card"
                        person={person}
                        profile={profile}
                        loading={loading}
                        role={roleWords(profile?.role, channel)}
                        actions={
                            <PersonActions
                                person={person}
                                channel={channel}
                                viewerId={viewerId}
                                onMention={onMention}
                                onNickname={onNickname}
                                onDone={onClose}
                            />
                        }
                    />
                </div>
            </DialogFloating>
        </Dialog>
    );
}

/**
 * The same profile with room: everything the card had, what the two of you
 * have in common, the whole of what they wrote, and the way to their own page.
 */
function PersonProfileDialog({
    person,
    channelId,
    viewerId,
    onMention,
    onNickname,
    onClose
}: {
    person: ProfilePerson;
    channelId: string;
    viewerId: string;
    onMention?: (text: string) => void;
    onNickname: (person: MenuPerson) => void;
    onClose: () => void;
}) {
    const { channels } = useChat();
    const channel = channels.find((entry) => entry.id === channelId);
    const { profile, loading } = useChatProfile(channelId, person.id);

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent aria-describedby={undefined} className="max-w-md overflow-x-hidden p-0">
                <DialogTitle className="sr-only">{profile?.name || person.name}</DialogTitle>
                <ProfileDetails
                    size="full"
                    person={person}
                    profile={profile}
                    loading={loading}
                    role={roleWords(profile?.role, channel)}
                    actions={
                        <PersonActions
                            person={person}
                            channel={channel}
                            viewerId={viewerId}
                            onMention={onMention}
                            onNickname={onNickname}
                            onDone={onClose}
                            extra={
                                // Only for somebody who has an address to go to:
                                // an account with no handle has no page.
                                profile?.username ? (
                                    <Button asChild size="sm" variant="secondary">
                                        <Link href={`/u/${profile.username}`} onClick={onClose}>
                                            <ArrowUpRight className="size-4" />
                                            Open profile page
                                        </Link>
                                    </Button>
                                ) : null
                            }
                        />
                    }
                />
            </DialogContent>
        </Dialog>
    );
}
