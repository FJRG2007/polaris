"use client";

/**
 * Who you are talking to, beside the conversation.
 *
 * A direct message had no right-hand panel at all: the roster is a list of
 * people and a conversation between two of them is not a list. But the column
 * was not the problem - what belongs there is the other person, which is what
 * every client with direct messages puts there, and what somebody actually
 * wants when they open one after a week away.
 *
 * What it shows is deliberately what one person may say about themselves: the
 * name they go by, the handle that tells two people with the same name apart,
 * what they wrote about themselves, and what they are showing today. Not their
 * address and not their number - those are two settings on their own privacy
 * screen, they default to nobody, and being in a conversation with somebody is
 * not consent to hand either over.
 *
 * It is drawn the way a person is drawn everywhere else in Polaris, and that is
 * the point rather than a detail: the dot rides on the face, where every other
 * screen puts it, instead of being spelled out as a line of its own under the
 * name. Somewhere with room to say it, the word goes beside what they are
 * showing today; the colour still has to mean the same thing here as it does in
 * the roster, or it means nothing anywhere.
 *
 * The shape is a profile rather than a centred card: a band across the top, the
 * face cut out of its lower edge on the left, and everything about them reading
 * down from there. Centring three lines of text under a circle is what a "who is
 * this" tooltip looks like; a profile is a thing with a top, and the band is what
 * gives it one. Almost nobody uploads a banner, so the band is a colour taken
 * from their own face - see `ProfileBanner`.
 *
 * And what you can do about them is here too, behind the same three dots that
 * carry it in every other list. This screen is about one person and has no list
 * to right-click along, so the whole of the person menu - message, call, mention,
 * nickname, silence, invite, block, and whatever moderation applies - was
 * unreachable from the one place devoted to them. It is the same menu, opened by
 * a press instead of a right-click, not a second copy of it.
 *
 * The dot and the words come from the presence store, which is already asking
 * about this person for the avatar in the header. So this costs one request for
 * the profile itself, once, and nothing after that.
 */

import { AtSign, MoreHorizontal, X } from "lucide-react";
import { profileAction } from "./actions";
import { useChat } from "./chat-context";
import { useWideScreen } from "./use-wide-screen";
import { useEffect, useState } from "react";
import { Avatar } from "@/components/avatar";
import { PRESENCE_WORDS } from "@polaris/core";
import { NicknameDialog } from "./nickname-dialog";
import type { ChatProfile } from "@/lib/chat/profiles";
import { MemberMenu, type MenuPerson } from "./member-menu";
import { usePresence } from "@/components/presence-store";
import { ProfileBanner } from "@/components/profile-banner";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Skeleton } from "@polaris/ui";

/** Somebody, as this panel draws them. */
export interface DirectPerson {
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
function useProfile(
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

/** The panel's contents, whichever shape it is drawn in. */
function Body({ person, channelId }: { person: DirectPerson; channelId: string }) {
    const { profile, loading } = useProfile(channelId, person.id);
    const where = usePresence(person.id);
    const name = profile?.name || person.name;

    return (
        <div className="flex flex-col">
            <ProfileBanner person={{ id: person.id, name }} className="h-16 shrink-0" />

            <div className="flex flex-col gap-3 px-4 pb-4">
                {/* Cut out of the band's lower edge, on the left, where a profile
                    puts a face. The ring is the page's own background rather than
                    a border: it is the cut-out, not a decoration, so it has to be
                    the colour of whatever the picture is sitting on. */}
                <div className="-mt-8">
                    {/* The dot rides on the face here as it does everywhere else,
                        rather than being spelled out underneath: somebody who has
                        learnt the colour in the roster should not have to learn a
                        second way of being told the same thing about that person. */}
                    <Avatar
                        openable
                        person={{ id: person.id, name }}
                        size={72}
                        className="ring-[3px] ring-background"
                    />
                </div>

                <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="truncate text-sm font-medium" title={name}>
                        {name}
                    </p>
                    {loading && !profile ? (
                        <Skeleton className="h-3 w-24" />
                    ) : (
                        profile?.username && (
                            <p className="flex items-center gap-0.5 truncate text-xs text-muted-foreground">
                                <AtSign className="size-3 shrink-0" />
                                {profile.username}
                            </p>
                        )
                    )}
                    {/* Their name, when it is not already what they are called
                        here. Two lines saying "Rahma Fellah" one under the other
                        is not more information about anybody. */}
                    {profile?.fullName && profile.fullName !== name && (
                        <p className="truncate text-xs text-muted-foreground" title={profile.fullName}>
                            {profile.fullName}
                        </p>
                    )}
                </div>

                {/* Where they are and what they are showing, in that order and in
                    one place. The word is still said - a colour on its own is a
                    convention somebody has to have learnt, and this is the one
                    screen with room to spell it out - but it sits with the note
                    rather than standing in for the dot. The note is only ever
                    there while they are actually here; see `presence-service`. */}
                {where && (
                    <div className="flex w-full flex-col gap-1">
                        <p className="text-xs text-muted-foreground">{PRESENCE_WORDS[where.status]}</p>
                        {where.note && (
                            <p className="w-full whitespace-pre-wrap break-words rounded-md bg-muted/40 px-3 py-2 text-xs text-foreground">
                                {where.note}
                            </p>
                        )}
                    </div>
                )}

                {profile?.description && (
                    <div className="w-full text-left">
                        <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-foreground-subtle">
                            About
                        </p>
                        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                            {profile.description}
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * The three dots, and behind them the menu a name carries everywhere else.
 *
 * Opened by a press rather than a right-click, which is the whole reason it is
 * here: a roster is a list somebody right-clicks along, and a screen about one
 * person is not - so every item in that menu was out of reach from the one place
 * devoted to them. Not a second menu. The same one, told how it is being opened.
 */
function PersonMenu({
    person,
    channel,
    onMention,
    onNickname,
    onError
}: {
    person: DirectPerson;
    channel: ChatChannelView;
    onMention: (text: string) => void;
    onNickname: (member: MenuPerson) => void;
    onError: (message: string) => void;
}) {
    const { viewerId, refresh } = useChat();

    return (
        <MemberMenu
            member={{ userId: person.id, name: person.name }}
            channel={channel}
            viewerId={viewerId}
            openWith="press"
            onMention={onMention}
            onNickname={onNickname}
            // A block changes what this conversation offers - a box, or a line
            // saying why there is none - so the rail is asked again rather than
            // left a screen behind.
            onChanged={refresh}
            onError={onError}
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
    );
}

/**
 * The profile, as a column beside the conversation or as a dialog over it.
 *
 * The same decision the roster makes, and made the same way: below the width
 * where both fit, a column of eighty pixels of conversation helps nobody.
 */
export function DirectProfile({
    person,
    channel,
    open,
    onOpenChange,
    onMention
}: {
    /** The other person, or null in a conversation whose other side has deleted
     *  their account - there is nobody to draw and the panel stays shut. */
    person: DirectPerson | null;
    /** The conversation they are being looked at in, which is what the person
     *  menu reads to decide which of its items apply - see `MemberMenu`. */
    channel: ChatChannelView;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Put them into what is being written. The composer owns the box; this only
     *  says what to drop in it. */
    onMention: (text: string) => void;
}) {
    // Before the early return, which is where a hook has to be: the same
    // question the roster asks, answered by the same hook so the two panels can
    // never disagree about whether there is room for a column.
    const wide = useWideScreen();
    /** Whose nickname is being changed, and anything the menu was refused. Both
     *  held out here rather than in the menu: the menu is unmounted the moment an
     *  item is chosen, and a dialog opened by something about to disappear never
     *  appears. */
    const [naming, setNaming] = useState<MenuPerson | null>(null);
    const [error, setError] = useState("");
    if (!person || !open) return null;

    const menu = (
        <PersonMenu
            person={person}
            channel={channel}
            onMention={onMention}
            onNickname={setNaming}
            onError={setError}
        />
    );

    const nickname = (
        <NicknameDialog
            open={naming !== null}
            person={naming ? { id: naming.userId, name: naming.name } : null}
            onOpenChange={(next) => !next && setNaming(null)}
            onSaved={() => setNaming(null)}
        />
    );

    const refusal = error ? (
        <p role="alert" className="px-4 pb-2 text-xs text-danger">
            {error}
        </p>
    ) : null;

    if (!wide) {
        return (
            <Dialog open onOpenChange={onOpenChange}>
                <DialogContent className="max-w-xs">
                    <DialogHeader>
                        {/* Room left on the right for the dialog's own close,
                            which sits in the corner this would otherwise be in. */}
                        <DialogTitle className="flex items-center justify-between gap-2 pr-6">
                            Profile
                            {menu}
                        </DialogTitle>
                    </DialogHeader>
                    <Body person={person} channelId={channel.id} />
                    {refusal}
                </DialogContent>
                {nickname}
            </Dialog>
        );
    }

    return (
        // A little wider than the roster, and wider again where there is room
        // for it: this column carries sentences - a handle, a name, what
        // somebody wrote about themselves - where the roster carries a list of
        // names. The extra width waits for 1280 because at 1024 every pixel here
        // comes off the conversation, which is already down to its last few
        // words at that size (see `useWideScreen`).
        <aside className="flex min-h-0 w-64 shrink-0 flex-col border-l border-border xl:w-72">
            <div className="flex items-center justify-between gap-1 border-b border-border px-3 py-2">
                <p className="text-xs font-medium uppercase tracking-[0.04em] text-foreground-subtle">
                    Profile
                </p>
                <span className="flex items-center gap-0.5">
                    {menu}
                    <button
                        type="button"
                        onClick={() => onOpenChange(false)}
                        aria-label="Close the profile"
                        title="Close"
                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <X className="size-3.5" />
                    </button>
                </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
                <Body person={person} channelId={channel.id} />
                {refusal}
            </div>
            {nickname}
        </aside>
    );
}
