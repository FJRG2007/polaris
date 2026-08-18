"use client";

/**
 * What conversation you are in, and what can be done to it.
 *
 * The topic sits beside the name rather than under it, because it is a subtitle
 * for the channel and not a second heading - and on a narrow screen it is the
 * first thing to go, since the name is what identifies the room.
 *
 * The back arrow only exists below the breakpoint where the conversation list
 * steps aside. Above it the list is right there, and an arrow that goes to a
 * place already on screen is furniture.
 */

import Link from "next/link";
import * as actions from "./actions";
import * as core from "@polaris/core";
import { useChat } from "./chat-context";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { Avatar } from "@/components/avatar";
import { LeaveDialog } from "./leave-dialog";
import { channelLink, copyText } from "./links";
import { useAppUrl } from "@/components/app-url";
import { ChatPictureDialog } from "./picture-dialog";
import { AddPeopleDialog } from "./add-people-dialog";
import { ChatAvatar } from "@/components/chat-avatar";
import { MuteOptions, type MenuParts } from "./mute-menu";
import { GroupSettingsDialog } from "./group-settings-dialog";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import {
    ArrowLeft,
    Hash,
    Image as ImageIcon,
    Link2,
    LogOut,
    Lock,
    MoreHorizontal,
    Pencil,
    Phone,
    PhoneOff,
    Search,
    Settings2,
    Trash2,
    UserPlus,
    Users,
    Video
} from "lucide-react";
import {
    Button,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
    Input
} from "@polaris/ui";

/** How the shared mute list draws itself inside a dropdown. */
const DROPDOWN_PARTS: MenuParts = {
    Item: DropdownMenuItem,
    Sub: DropdownMenuSub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent
};

export function ChannelHeader({
    channel,
    viewerId,
    onChanged,
    call,
    onStartCall,
    onSearch,
    onMembers
}: {
    channel: ChatChannelView;
    /** Who is reading, which decides one thing here: a group's owner is the only
     *  person for whom its settings are a question. */
    viewerId: string;
    onChanged: () => void;
    /** The call running in this conversation, if there is one, so somebody who
     *  arrives late can see it rather than start a second one. */
    call: { meetingId: string; count: number } | null;
    /** Start or join. The flag is whether to open the camera - two buttons
     *  rather than one, because deciding afterwards means everybody in the room
     *  has already seen you. */
    onStartCall: (withVideo: boolean) => void;
    /** Absent where there is nothing to search - a voice room holds no
     *  messages, and a button that does nothing is worse than no button. */
    onSearch?: () => void;
    /** Show or hide who is in here. Absent in a one-to-one conversation, where
     *  the roster is the two people already named at the top. */
    onMembers?: () => void;
}) {
    const router = useRouter();
    const baseUrl = useAppUrl();
    const { may, callsOff } = useChat();
    const mayCall = may.call;
    const [adding, setAdding] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [picturing, setPicturing] = useState(false);
    const [settings, setSettings] = useState(false);
    const [naming, setNaming] = useState(false);
    const [nickname, setNickname] = useState("");
    const [name, setName] = useState("");
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [leaving, setLeaving] = useState(false);
    const [error, setError] = useState("");

    const named = channel.spaceId !== null;
    // A group belongs to everybody in it: any of them can name it, add somebody
    // and walk out. What none of them can do is turn anybody else out.
    const group = channel.kind === "group";

    useEffect(() => {
        if (renaming) setName(channel.name);
    }, [renaming, channel.name]);
    const Icon = channel.private ? Lock : named ? Hash : Users;

    /**
     * Run one of these actions and say what happened.
     *
     * A refusal comes back as a value rather than as a throw - which is the shape
     * an action should have - so it has to be read out of the result. Left to
     * `runAction`, which only catches what was thrown, every refusal from this
     * header was silent: the dialog closed, nothing changed, and the screen said
     * nothing about why. Returns whether it worked, so a form can stay open.
     */
    const act = async (run: () => Promise<{ error?: string }>): Promise<boolean> => {
        setError("");
        const result = await runAction(run, setError);
        if (!result) return false;
        if (result.error) {
            setError(result.error);
            return false;
        }
        onChanged();
        return true;
    };

    return (
        <>
            <div className="flex h-header shrink-0 items-center gap-2 border-b border-border px-3">
                <Link
                    href="/chat"
                    aria-label="Back to conversations"
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
                >
                    <ArrowLeft className="size-4" />
                </Link>

                {/* A named channel is its hash; a conversation is who is in
                    it - one face for a direct message, the group's picture or
                    the faces of its people for a group. */}
                {named ? (
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                ) : channel.others.length === 1 && channel.others[0] ? (
                    <Avatar openable person={channel.others[0]} size={20} />
                ) : (
                    <ChatAvatar
                        kind="channel"
                        id={channel.id}
                        name={channel.name}
                        members={channel.others}
                        size={20}
                    />
                )}
                <span className="truncate text-sm font-semibold" title={channel.name}>
                    {channel.name}
                </span>
                {channel.topic && (
                    <>
                        <span className="hidden h-4 w-px bg-border sm:block" />
                        <span
                            className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:block"
                            title={channel.topic}
                        >
                            {channel.topic}
                        </span>
                    </>
                )}

                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                    {onMembers && (
                        <button
                            type="button"
                            onClick={onMembers}
                            aria-label="Who is in here"
                            title="Who is in here"
                            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            <Users className="size-4" />
                        </button>
                    )}
                    {onSearch && (
                        <button
                            type="button"
                            onClick={onSearch}
                            aria-label="Search messages"
                            title="Search messages"
                            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            <Search className="size-4" />
                        </button>
                    )}
                    {/* An account that may not be in calls is not shown the way
                        in, and is not told a call is running either: it is a room
                        it cannot enter. */}
                    {!mayCall ? null : callsOff ? (
                        // Drawn, and refused. Taking the button away would leave
                        // a conversation that simply has no calls in it, with
                        // nowhere to read why; this way the reason is one hover
                        // from anybody wondering where the call button went, and
                        // it comes back on its own when the server does.
                        <button
                            type="button"
                            disabled
                            aria-label="Calls are unavailable"
                            title={callsOff}
                            className="cursor-not-allowed rounded p-1.5 text-foreground-subtle"
                        >
                            <PhoneOff className="size-4" />
                        </button>
                    ) : call ? (
                        // One button once a call is running: joining is joining,
                        // and the camera is a switch inside the room.
                        //
                        // Without a camera, which is the whole of the difference
                        // between this and the two buttons below. Starting a
                        // video call is a decision somebody makes; walking into
                        // one that is already happening is not, and it used to
                        // open the camera anyway - so joining a conversation to
                        // hear what was being said put your face on everybody's
                        // screen without a single press that said so.
                        <button
                            type="button"
                            onClick={() => onStartCall(false)}
                            aria-label="Join the call"
                            title="Join the call"
                            className="flex items-center gap-1.5 rounded-md bg-primary/15 px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-primary/25"
                        >
                            <Phone className="size-4" />
                            <span>{call.count}</span>
                        </button>
                    ) : (
                        <>
                            <button
                                type="button"
                                onClick={() => onStartCall(false)}
                                aria-label="Start a call"
                                title="Start a call"
                                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                <Phone className="size-4" />
                            </button>
                            <button
                                type="button"
                                onClick={() => onStartCall(true)}
                                aria-label="Start a video call"
                                title="Start a video call"
                                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                <Video className="size-4" />
                            </button>
                        </>
                    )}
                    {(named || group) && (
                        <button
                            type="button"
                            aria-label="Add people"
                            title="Add people"
                            onClick={() => setAdding(true)}
                            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            <UserPlus className="size-4" />
                        </button>
                    )}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                aria-label="More for this conversation"
                                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                <MoreHorizontal className="size-4" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            {/* Every conversation has an address, whether it is
                                a channel, a group or one person - they are one
                                kind of thing with one id. */}
                            <DropdownMenuItem
                                onSelect={() => void copyText(channelLink(baseUrl, channel.id))}
                            >
                                <Link2 className="size-3.5" />
                                Copy link
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <MuteOptions
                                channel={channel}
                                parts={DROPDOWN_PARTS}
                                onChoose={(minutes) =>
                                    void act(() => actions.setMutedAction(channel.id, minutes))
                                }
                            />
                            {/* A conversation with one other person in it. What
                                you call them is yours: nothing is announced, and
                                they go on being called what they call themselves
                                everywhere but here. */}
                            {!named && !group && channel.others.length === 1 && (
                                <DropdownMenuItem onSelect={() => setNaming(true)}>
                                    <Pencil className="size-3.5" />
                                    Nickname
                                </DropdownMenuItem>
                            )}
                            {group && (
                                <>
                                    {/* The same permission as the picture, and now
                                        gated on it: the name and the picture are
                                        one decision, and offering a rename the
                                        server goes on to refuse is worse than not
                                        offering it. */}
                                    {channel.mayPicture && (
                                        <DropdownMenuItem onSelect={() => setRenaming(true)}>
                                            <Pencil className="size-3.5" />
                                            Name this group
                                        </DropdownMenuItem>
                                    )}
                                    {channel.mayPicture && (
                                        <DropdownMenuItem onSelect={() => setPicturing(true)}>
                                            <ImageIcon className="size-3.5" />
                                            Group picture
                                        </DropdownMenuItem>
                                    )}
                                    {/* Only the owner's. Offering a switch the
                                        server will refuse is worse than not
                                        offering it. */}
                                    {channel.ownerId === viewerId && (
                                        <DropdownMenuItem onSelect={() => setSettings(true)}>
                                            <Settings2 className="size-3.5" />
                                            Group settings
                                        </DropdownMenuItem>
                                    )}
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                        variant="danger"
                                        onSelect={() => setLeaving(true)}
                                    >
                                        <LogOut className="size-3.5" />
                                        Leave this group
                                    </DropdownMenuItem>
                                </>
                            )}
                            {named && (
                                <>
                                    <DropdownMenuItem
                                        onSelect={() =>
                                            void act(() =>
                                                actions.updateChannelAction({
                                                    channelId: channel.id,
                                                    archived: !channel.archived
                                                })
                                            )
                                        }
                                    >
                                        {channel.archived ? "Reopen channel" : "Archive channel"}
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                        variant="danger"
                                        onSelect={() => setConfirmDelete(true)}
                                    >
                                        <Trash2 className="size-3.5" />
                                        Delete channel
                                    </DropdownMenuItem>
                                </>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>

            {error && (
                <p role="alert" className="border-b border-border px-4 py-1 text-xs text-danger">
                    {error}
                </p>
            )}

            {/* Opened on what they are called now, which is either the nickname
                already set or their own name - so clearing the box is how the
                nickname comes off. */}
            <Dialog
                open={naming}
                onOpenChange={(next: boolean) => {
                    setNaming(next);
                    if (next) setNickname(channel.others[0]?.name ?? "");
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>What you call them</DialogTitle>
                    </DialogHeader>
                    <Input
                        value={nickname}
                        autoFocus
                        maxLength={60}
                        aria-label="What you call them"
                        placeholder="Leave it empty to use their own name"
                        onChange={(event) => setNickname(event.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                        Only you see this. They are not told, and everybody else goes on seeing
                        their own name.
                    </p>
                    <DialogFooter>
                        <Button variant="ghost" size="sm" onClick={() => setNaming(false)}>
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            onClick={async () => {
                                const person = channel.others[0];
                                if (!person) return;
                                await runAction(
                                    () => actions.setNicknameAction(person.id, nickname),
                                    setError
                                );
                                setNaming(false);
                                onChanged();
                            }}
                        >
                            Save
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {group && (
                <LeaveDialog
                    open={leaving}
                    onOpenChange={setLeaving}
                    kind="group"
                    name={channel.name}
                    error={leaving ? error : ""}
                    onLeave={async (quietly) => {
                        setError("");
                        const result = await runAction(
                            () => actions.leaveChannelAction(channel.id, quietly),
                            setError
                        );
                        // Left open on a refusal, with the reason on it: a
                        // dialog that closes and leaves you in the group is a
                        // dialog that looks like it worked.
                        if (!result || result.error) {
                            if (result?.error) setError(result.error);
                            return;
                        }
                        setLeaving(false);
                        onChanged();
                        router.push("/chat");
                    }}
                />
            )}

            {group && (
                <GroupSettingsDialog
                    channel={channel}
                    open={settings}
                    onOpenChange={setSettings}
                    onChanged={onChanged}
                />
            )}

            <ChatPictureDialog
                open={picturing}
                onOpenChange={setPicturing}
                kind="channel"
                id={channel.id}
                name={channel.name}
                members={channel.others}
                // Drawn from one URL in half a dozen places, none of which will
                // ask for it again on their own: the elements already on screen
                // are pointed at exactly the address they were. The bytes in the
                // browser have been replaced by now, so this is a redraw and not
                // a round trip.
                onChanged={() => window.location.reload()}
            />

            <AddPeopleDialog
                open={adding}
                onOpenChange={setAdding}
                channel={channel}
                onAdded={onChanged}
            />

            <Dialog open={renaming} onOpenChange={setRenaming}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Name this group</DialogTitle>
                    </DialogHeader>
                    <Input
                        value={name}
                        autoFocus
                        maxLength={core.MAX_CHAT_CHANNEL_NAME}
                        placeholder="Leave it empty to go back to the names"
                        aria-label="What this group is called"
                        onChange={(event) => setName(event.target.value)}
                    />
                    {/* Inside the dialog, not only in the banner behind it: the
                        banner is covered by this while it is open, which is how a
                        refusal used to reach nobody. */}
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <DialogFooter>
                        <Button variant="ghost" size="sm" onClick={() => setRenaming(false)}>
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            onClick={async () => {
                                // Closed only once it worked. A dialog that closes
                                // on a refusal takes the typed name with it and
                                // leaves the reader looking at an unchanged group.
                                const done = await act(() =>
                                    actions.renameGroupAction({
                                        channelId: channel.id,
                                        name
                                    })
                                );
                                if (done) setRenaming(false);
                            }}
                        >
                            Save
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <ConfirmDeleteDialog
                open={confirmDelete}
                onOpenChange={setConfirmDelete}
                name={channel.name}
                kind="channel"
                description="Every message in it goes with it. Archiving keeps them readable instead."
                confirmLabel="Delete channel"
                onConfirm={async () => {
                    await runAction(() => actions.deleteChannelAction(channel.id), setError);
                    setConfirmDelete(false);
                    onChanged();
                    router.push("/chat");
                }}
            />
        </>
    );
}
