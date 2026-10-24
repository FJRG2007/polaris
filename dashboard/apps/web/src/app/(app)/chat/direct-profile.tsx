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
 * Discord's column, not a titled panel: no "Profile" bar across the top - the
 * band is the top - with the friend request and the three dots laid over the
 * band, the two halves of what you have in common as counts that open, the bio
 * cut to a few lines with the rest one press away, when they joined, and the
 * way to the larger view at the bottom.
 *
 * The line they are showing comes from the presence store, which is already
 * asking about this person for the avatar in the header. So this costs one
 * request for the profile itself, once, and nothing after that.
 */

import { Clock, MoreHorizontal, UserPlus, X } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useChat } from "./chat-context";
import { SidePane } from "./side-pane";
import { useWideScreen } from "./use-wide-screen";
import { useState } from "react";
import { askFriendAction } from "./actions";
import { NicknameDialog } from "./nickname-dialog";
import { PersonProfileDialog } from "./person-card";
import { MemberMenu, type MenuPerson } from "./member-menu";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import type { ChatProfile } from "@/lib/chat/profiles";
import { Button, Dialog, DialogContent, DialogTitle } from "@polaris/ui";
import { ProfileDetails, useChatProfile } from "./profile-details";

/** Somebody, as this panel draws them. */
export interface DirectPerson {
    readonly id: string;
    readonly name: string;
}

/** The round, see-through buttons laid over the band. Over a picture or a
 *  colour taken from one, so they carry their own backing to stay readable. */
const ON_BANNER =
    "size-8 rounded-full bg-background/80 text-foreground shadow-sm backdrop-blur hover:bg-background";

/**
 * Discord's add-friend button on the band.
 *
 * Only when there is a request to make: nothing for yourself or a friend, and a
 * still clock for one already waiting either way. Optimistic - it turns into the
 * clock when pressed and back, with the reason, if the request did not go.
 */
function AddFriend({
    person,
    standing,
    onError
}: {
    person: DirectPerson;
    standing: ChatProfile["friendship"] | undefined;
    onError: (message: string) => void;
}) {
    const t = useTranslations("chat");
    const { friends } = useChat();
    const [sent, setSent] = useState(false);
    if (!standing || standing === "self" || standing === "friends" || friends.has(person.id))
        return null;

    if (standing === "pending" || sent) {
        return (
            <Button
                variant="ghost"
                size="icon-sm"
                disabled
                className={ON_BANNER}
                aria-label={t("directProfile.requestPending")}
                title={t("directProfile.requestPending")}
            >
                <Clock className="size-4" />
            </Button>
        );
    }

    const ask = async () => {
        setSent(true);
        onError("");
        const result = await askFriendAction(person.id).catch(() => ({
            error: t("groupPicker.requestFailed")
        }));
        if (result.error) {
            setSent(false);
            onError(result.error);
        }
    };

    return (
        <Button
            variant="ghost"
            size="icon-sm"
            className={ON_BANNER}
            aria-label={t("directProfile.addFriend", { name: person.name })}
            title={t("directProfile.addFriendShort")}
            onClick={() => void ask()}
        >
            <UserPlus className="size-4" />
        </Button>
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
    const t = useTranslations("chat");
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
                className={ON_BANNER}
                aria-label={t("personCard.actionsFor", { name: person.name })}
                title={t("directProfile.more")}
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
    const t = useTranslations("chat");
    const { viewerId } = useChat();
    // Before the early return, which is where a hook has to be: the same
    // question the roster asks, answered by the same hook so the two panels can
    // never disagree about whether there is room for a column.
    const wide = useWideScreen();
    const { profile, loading } = useChatProfile(channel.id, open ? (person?.id ?? null) : null);
    /** Whose nickname is being changed, and anything the menu was refused. Both
     *  held out here rather than in the menu: the menu is unmounted the moment an
     *  item is chosen, and a dialog opened by something about to disappear never
     *  appears. */
    const [naming, setNaming] = useState<MenuPerson | null>(null);
    const [error, setError] = useState("");
    /** The larger view, opened from the button at the bottom. */
    const [expanded, setExpanded] = useState(false);
    if (!person || !open) return null;

    const bannerActions = (
        <>
            <AddFriend person={person} standing={profile?.friendship} onError={setError} />
            <PersonMenu
                person={person}
                channel={channel}
                onMention={onMention}
                onNickname={setNaming}
                onError={setError}
            />
            {/* The dialog brings its own close; the column needs one. */}
            {wide ? (
                <Button
                    variant="ghost"
                    size="icon-sm"
                    className={ON_BANNER}
                    onClick={() => onOpenChange(false)}
                    aria-label={t("directProfile.closeTheProfile")}
                    title={t("directProfile.close")}
                >
                    <X className="size-4" />
                </Button>
            ) : (
                // Room for the dialog's own close, which sits in this corner.
                <span aria-hidden className="w-7" />
            )}
        </>
    );

    const refusal = error ? (
        <p role="alert" className="px-4 pb-2 text-xs text-danger">
            {error}
        </p>
    ) : null;

    const details = (
        <ProfileDetails
            person={person}
            profile={profile}
            loading={loading}
            bannerActions={bannerActions}
            footer={
                <Button
                    variant="secondary"
                    size="sm"
                    className="w-full"
                    onClick={() => setExpanded(true)}
                >
                    {t("personCard.viewFullProfile")}
                </Button>
            }
        />
    );

    const extras = (
        <>
            <NicknameDialog
                open={naming !== null}
                person={naming ? { id: naming.userId, name: naming.name } : null}
                onOpenChange={(next) => !next && setNaming(null)}
                onSaved={() => setNaming(null)}
            />
            {expanded ? (
                <PersonProfileDialog
                    person={person}
                    channelId={channel.id}
                    viewerId={viewerId}
                    onMention={onMention}
                    onNickname={setNaming}
                    onClose={() => setExpanded(false)}
                />
            ) : null}
        </>
    );

    if (!wide) {
        return (
            <Dialog open onOpenChange={onOpenChange}>
                <DialogContent
                    aria-describedby={undefined}
                    className="max-w-xs overflow-hidden p-0"
                >
                    {/* Named for a screen reader; the band is the visible top. */}
                    <DialogTitle className="sr-only">{profile?.name || person.name}</DialogTitle>
                    {details}
                    {refusal}
                </DialogContent>
                {extras}
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
            label={t("directProfile.profileWidth")}
            className="border-l border-border"
        >
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                {refusal}
                {details}
            </div>
            {extras}
        </SidePane>
    );
}
