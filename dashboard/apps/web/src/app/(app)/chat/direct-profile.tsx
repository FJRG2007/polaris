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
 * screen puts it, and it is the only thing that says where they are. The word
 * used to be printed underneath as well, which was the same fact twice - and the
 * second one cost a line of a narrow panel to tell somebody what the colour on
 * the face had already told them. It survives on the dot's own label and
 * tooltip, so nobody who cannot read a colour loses it.
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
 * The line they are showing comes from the presence store, which is already
 * asking about this person for the avatar in the header. So this costs one
 * request for the profile itself, once, and nothing after that.
 */

import { MoreHorizontal, X } from "lucide-react";
import { useChat } from "./chat-context";
import { SidePane } from "./side-pane";
import { useWideScreen } from "./use-wide-screen";
import { useState } from "react";
import { NicknameDialog } from "./nickname-dialog";
import { MemberMenu, type MenuPerson } from "./member-menu";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from "@polaris/ui";
import { ProfileDetails, useChatProfile } from "./profile-details";

/** Somebody, as this panel draws them. */
export interface DirectPerson {
    readonly id: string;
    readonly name: string;
}

/** The panel's contents, whichever shape it is drawn in - the same profile the
 *  card a pressed name opens draws, see `ProfileDetails`. */
function Body({ person, channelId }: { person: DirectPerson; channelId: string }) {
    const { profile, loading } = useChatProfile(channelId, person.id);
    return <ProfileDetails person={person} profile={profile} loading={loading} />;
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

/** A little wider than the roster by default: this column carries sentences - a
 *  handle, a name, what somebody wrote about themselves - where the roster
 *  carries a list of names. */
const PROFILE_PANE = { min: 224, max: 440, fallback: 272 };

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
        // Sized by whoever is reading, like the roster: at 1024 every pixel here
        // comes off the conversation (see `useWideScreen`), and the ceiling
        // keeps a width chosen on a wider screen from taking it.
        <SidePane
            pane="profile"
            bounds={PROFILE_PANE}
            label="Profile width"
            className="border-l border-border"
        >
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
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <Body person={person} channelId={channel.id} />
                {refusal}
            </div>
            {nickname}
        </SidePane>
    );
}
