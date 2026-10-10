"use client";

/**
 * A meeting, from the inside, for somebody who has an account.
 *
 * Laid out the way a voice room is - the call taking the width, its chat down
 * the side - because that is what a meeting is: a room with people in it and a
 * column for the things a call cannot carry. A guest reaching the same meeting
 * on a link gets the same two halves with no dashboard around them.
 *
 * Joining is a press, never an arrival. The address carries the press and is
 * stripped as soon as it is acted on, for the reason every other room in Chat
 * does it: reloading a page is not somebody asking to open a microphone, and
 * neither is a link restored by a browser that reopened yesterday's windows.
 *
 * What is on this screen and not on the guest's is the hosting: convening people
 * who have accounts, handing the room over, showing somebody out, and the two
 * doors. Every one of them is refused at the server for anybody but the host -
 * this only decides what is worth drawing.
 */

import Link from "next/link";
import { runAction } from "@/lib/run-action";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useAppUrl } from "@/components/app-url";
import { copyText } from "@/app/(app)/chat/links";
import { CallRoom } from "@/app/(app)/chat/call-room";
import { useCallHold } from "@/app/(app)/chat/call-hold";
import type { MeetingSummary } from "@/lib/chat/meetings";
import { CallRoster } from "@/app/(app)/chat/call-roster";
import { MeetingChat } from "@/app/(app)/chat/meeting-chat";
import { SidePane } from "@/app/(app)/chat/side-pane";
import { CALL_CHAT_PANE } from "@/app/(app)/chat/use-chat-pane";
import { useRouter, useSearchParams } from "next/navigation";
import { searchPeopleAction } from "@/app/(app)/chat/actions";
import { useDisplayFormat } from "@/components/display-format";
import { useCallback, useEffect, useRef, useState } from "react";
import { MeetingDetailsDialog } from "../meeting-details-dialog";
import { useLobbyAdmission } from "@/app/(app)/chat/use-lobby-admission";
import { PeoplePicker, type PickedPerson } from "@/components/people-picker";
import { ArrowLeft, Crown, Link2, LogOut, Loader2, Pencil, UserMinus, UserPlus, Video } from "lucide-react";
import {
    Button,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Switch,
    cn
} from "@polaris/ui";
import {
    endMeetingAction,
    inviteToMeetingAction,
    joinMeetingAction,
    listMeetingsAction,
    removeFromMeetingAction,
    setMeetingOptionsAction,
    transferHostAction
} from "@/app/(app)/chat/meeting-actions";

export function MeetingRoom({ meetingId, viewerId }: { meetingId: string; viewerId: string }) {
    const t = useTranslations("chat");
    const router = useRouter();
    const params = useSearchParams();
    const baseUrl = useAppUrl();
    const format = useDisplayFormat();
    const { call, session, enter, leave: leaveCall } = useCallHold();
    const inCall = session?.meetingId === meetingId;

    /** What this account knows about the meeting from outside it - its name, its
     *  time, whether this is the host. Read even when nobody has joined yet,
     *  which is the whole point of the screen before the call starts. */
    const [about, setAbout] = useState<MeetingSummary | null>(null);
    const [gone, setGone] = useState(false);
    const [joining, setJoining] = useState(false);
    const [waiting, setWaiting] = useState(false);
    const [error, setError] = useState("");
    const [inviting, setInviting] = useState(false);
    const [ending, setEnding] = useState(false);
    /** Whether the name and hour are being changed. */
    const [editing, setEditing] = useState(false);
    const [copied, setCopied] = useState(false);

    const load = useCallback(async () => {
        const result = await listMeetingsAction();
        const found = result.meetings.find((meeting) => meeting.id === meetingId) ?? null;
        setAbout(found);
        // Not on the list and not in the room: it ended, or it was never this
        // account's to see. The same answer either way, deliberately - which of
        // the two it is answers a question somebody probing addresses wanted
        // answered.
        setGone(found === null);
    }, [meetingId]);

    useEffect(() => {
        void load();
    }, [load]);

    // Who is in the room, kept current for somebody looking at it from outside.
    // A meeting belongs to no conversation, so nothing is announced to this
    // screen when somebody walks in or mutes; it asks instead.
    useEffect(() => {
        if (inCall || gone || waiting) return;
        const timer = setInterval(() => {
            if (document.hidden) return;
            load().catch(() => undefined);
        }, OUTSIDE_POLL_MS);
        return () => clearInterval(timer);
    }, [gone, inCall, load, waiting]);

    const join = useCallback(async () => {
        setJoining(true);
        const result = await runAction(() => joinMeetingAction(meetingId), setError);
        setJoining(false);
        if (!result || result.error) return;
        if (result.admission === "waiting") {
            setWaiting(true);
            return;
        }
        setWaiting(false);
        enter(
            {
                meetingId,
                // A meeting has no conversation. The bar reads this to know it
                // is already on screen, and the address below to lead back here.
                channelId: "",
                title: about?.title || t("meetingRoom.meeting"),
                href: `/chat/meetings/${meetingId}`
            },
            false
        );
        void load();
    }, [about?.title, enter, load, meetingId]);

    /**
     * Arrived by pressing Join somewhere else.
     *
     * The press travels in the address and is taken out of it as soon as it is
     * acted on - see the walk-in in `channel-view`, which is the same rule for
     * the same reason.
     */
    const pressed = params.get("join");
    const walked = useRef(false);
    useEffect(() => {
        if (!pressed || walked.current || inCall) return;
        walked.current = true;
        router.replace(`/chat/meetings/${meetingId}`, { scroll: false });
        void join();
    }, [inCall, join, meetingId, pressed, router]);

    /**
     * Waiting at the door.
     *
     * Heard first and asked for second. The room's own stream says the moment a
     * seat is let in, which is what takes the wait after somebody presses "let
     * them in" down from up to three seconds of nothing to none; the poll behind
     * it catches a refusal, which the stream deliberately does not carry, and a
     * stream that could not be opened at all. The guest page does the same.
     */
    useLobbyAdmission(waiting ? meetingId : null, () => void join());
    useEffect(() => {
        if (!waiting) return;
        const timer = setInterval(() => void join(), LOBBY_POLL_MS);
        return () => clearInterval(timer);
    }, [join, waiting]);

    const host = about?.mine ?? false;
    const admitted = (call.meeting?.participants ?? []).filter(
        (person) => person.admission === "admitted"
    );

    if (gone) {
        return (
            <Empty
                title={t("meetingRoom.thisMeetingIsNotHere")}
                message={t("meetingRoom.itEndedOrItWas")}
            />
        );
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <header className="flex h-header shrink-0 flex-wrap items-center gap-2 border-b border-border px-4">
                    {/* On a phone this page has the whole screen, so it carries the
                        way back to the list, as a conversation's header does. */}
                    <Link
                        href="/chat"
                        aria-label={t("channelHeader.backToConversations")}
                        className="-ml-1.5 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
                    >
                        <ArrowLeft className="size-4" />
                    </Link>
                    <Video className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm">
                        {/* The room's own copy first: it is re-read whenever the
                            roster moves, so a host renaming the meeting mid-call
                            reaches everybody in it rather than only themselves. */}
                        <span className="font-medium">
                            {call.meeting?.title || about?.title || t("meetingRoom.meeting")}
                        </span>
                        {about && (
                            <span className="text-muted-foreground">
                                {" - "}
                                {about.mine ? t("meetingRoom.youAreHosting") : t("meetingRoom.hostedBy", { name: about.hostName })}
                                {about.scheduledAt ? `, ${format.dateTime(about.scheduledAt)}` : ""}
                            </span>
                        )}
                    </span>

                    {about?.guestToken && (
                        <Button
                            size="xs"
                            variant="secondary"
                            title={t("meetingRoom.copyTheLinkToSend")}
                            onClick={async () => {
                                await copyText(`${baseUrl}/m/${about.guestToken}`);
                                setCopied(true);
                                window.setTimeout(() => setCopied(false), 2000);
                            }}
                        >
                            <Link2 className="size-3.5" />
                            {copied ? t("meetingRoom.copied") : t("meetingRoom.copyLink")}
                        </Button>
                    )}
                    {host && (
                        <>
                            <Button size="xs" variant="secondary" onClick={() => setInviting(true)}>
                                <UserPlus className="size-3.5" />
                                {t("meetingRoom.invite")}
                            </Button>
                            {/* The name and the hour, which used to be settable
                                once and never again: a meeting that moved could
                                only be ended and made afresh, taking its link
                                with it. */}
                            <Button
                                size="icon-xs"
                                variant="secondary"
                                title={t("meetingRoom.renameOrReschedule")}
                                aria-label={t("meetingRoom.renameOrRescheduleThisMeeting")}
                                onClick={() => setEditing(true)}
                            >
                                <Pencil className="size-3.5" />
                            </Button>
                            <Button size="xs" variant="danger" onClick={() => setEnding(true)}>
                                <LogOut className="size-3.5" />
                                {t("meetingRoom.end")}
                            </Button>
                        </>
                    )}
                </header>

                {error && (
                    <p
                        role="alert"
                        className="border-b border-border px-4 py-2 text-sm text-danger"
                    >
                        {error}
                    </p>
                )}

                {inCall ? (
                    <div className="flex min-h-0 flex-1 flex-col">
                        <CallRoom
                            // A room: the call has the width and the meeting's
                            // chat is down the side, not underneath it.
                            place="room"
                            call={call}
                            meetingId={meetingId}
                            viewerId={viewerId}
                            onLeave={() => {
                                leaveCall();
                                void load();
                            }}
                        />
                    </div>
                ) : (
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                        <p className="text-sm text-muted-foreground">
                            {waiting
                                ? t("meetingRoom.waitingForTheHostTo")
                                : about?.present
                                  ? t("meetingRoom.present", { count: about.present })
                                  : t("meetingRoom.nobodyIsInHereYet")}
                        </p>
                        {!waiting && about && about.people.length > 0 && (
                            <CallRoster people={about.people} />
                        )}
                        <Button disabled={joining || waiting} onClick={() => void join()}>
                            {(joining || waiting) && <Loader2 className="size-4 animate-spin" />}
                            {waiting ? t("meetingRoom.waitingToBeLetIn") : t("meetingRoom.join")}
                        </Button>
                    </div>
                )}

                {host && (
                    <HostPanel
                        meetingId={meetingId}
                        about={about}
                        people={admitted.map((person) => ({
                            id: person.id,
                            name: person.name,
                            guest: person.guest,
                            self: person.userId === viewerId
                        }))}
                        onChanged={load}
                        onError={setError}
                    />
                )}
            </div>

            {/* The column beside the room, and only once there is a room: the
                chat belongs to the meeting, and somebody who has not joined is
                not in it to read or to be read by. */}
            {inCall && (
                <SidePane
                    pane="call-chat"
                    bounds={CALL_CHAT_PANE}
                    beside="lg"
                    label={t("meetingRoom.meetingChatWidth")}
                    // Under the room on a phone, held to a third of the screen
                    // so the call keeps the rest; it scrolls inside that.
                    className="max-h-[33dvh] border-t border-border lg:max-h-none lg:border-l lg:border-t-0"
                >
                    <MeetingChat meetingId={meetingId} call={call} className="flex-1" />
                </SidePane>
            )}

            <MeetingDetailsDialog
                open={editing}
                meetingId={meetingId}
                title={about?.title ?? ""}
                scheduledAt={about?.scheduledAt ?? null}
                onClose={() => setEditing(false)}
                onSaved={load}
                onError={setError}
            />

            <InviteDialog
                open={inviting}
                meetingId={meetingId}
                onClose={() => setInviting(false)}
                onInvited={load}
                onError={setError}
            />

            <ConfirmDeleteDialog
                open={ending}
                onOpenChange={(next) => !next && setEnding(false)}
                name={about?.title ?? t("meetingRoom.thisMeeting")}
                kind="meeting"
                requireTyping={false}
                title={t("meetingRoom.endThisMeeting")}
                question={t.rich("meetingRoom.endQuestion", {
                    name: about?.title ?? t("meetingRoom.thisMeeting"),
                    strong: (chunks) => (
                        <span key="name" className="font-medium text-foreground">
                            {chunks}
                        </span>
                    )
                })}
                description={t("meetingRoom.everybodyInItIsDropped")}
                confirmLabel={t("meetingRoom.endMeeting")}
                onConfirm={async () => {
                    setEnding(false);
                    const result = await runAction(() => endMeetingAction(meetingId), setError);
                    if (!result?.error) {
                        leaveCall();
                        router.push("/chat/meetings");
                    }
                }}
            />
        </div>
    );
}

/** How often the lobby asks whether it has been let in. Often enough not to feel
 *  stuck, rarely enough that a forgotten tab is not a load. */
const LOBBY_POLL_MS = 3000;
/** How often the room is re-read by somebody outside it, for who is in there. */
const OUTSIDE_POLL_MS = 8000;

/**
 * The host's own controls.
 *
 * Two doors and a roster. The doors are the decisions somebody makes once, when
 * they realise the link went further than they meant; the roster is the one they
 * make in the moment, about a person who is in the room.
 */
function HostPanel({
    meetingId,
    about,
    people,
    onChanged,
    onError
}: {
    meetingId: string;
    about: MeetingSummary | null;
    people: readonly { id: string; name: string; guest: boolean; self: boolean }[];
    onChanged: () => void | Promise<void>;
    onError: (message: string) => void;
}) {
    const t = useTranslations("chat");
    const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);

    const set = async (options: { approveGuests?: boolean; requireAccount?: boolean }) => {
        const result = await runAction(
            () => setMeetingOptionsAction({ meetingId, ...options }),
            onError
        );
        if (!result?.error) await onChanged();
    };

    return (
        // Held short on a phone, where it shares the screen with the call and the
        // chat; the people in it scroll inside.
        <section className="max-h-[25dvh] shrink-0 overflow-y-auto border-t border-border px-4 py-3 lg:max-h-none">
            <h2 className="text-xs font-medium text-muted-foreground">{t("meetingRoom.hosting")}</h2>

            <div className="mt-2 flex flex-col gap-2">
                <label className="flex items-center justify-between gap-4">
                    <span className="text-xs">
                        {t("meetingRoom.letPeopleInYourself")}
                        <span className="block text-[0.6875rem] text-muted-foreground">
                            {t("meetingRoom.anybodyOnTheLinkWaits")}
                        </span>
                    </span>
                    <Switch
                        aria-label={t("meetingRoom.letPeopleInYourself")}
                        checked={about?.approveGuests ?? true}
                        onChange={(next) => void set({ approveGuests: next })}
                    />
                </label>
                <label className="flex items-center justify-between gap-4">
                    <span className="text-xs">
                        {t("meetingRoom.polarisAccountsOnly")}
                        <span className="block text-[0.6875rem] text-muted-foreground">
                            {t("meetingRoom.theLinkNamesTheMeeting")}
                        </span>
                    </span>
                    <Switch
                        aria-label={t("meetingRoom.polarisAccountsOnly")}
                        checked={about?.requireAccount ?? false}
                        onChange={(next) => void set({ requireAccount: next })}
                    />
                </label>
            </div>

            {people.length > 0 && (
                <ul className="mt-3 flex flex-col gap-1">
                    {people.map((person) => (
                        <li key={person.id} className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-xs">
                                {person.name}
                                {person.guest && (
                                    <span className="text-muted-foreground">{t("meetingRoom.guestSuffix")}</span>
                                )}
                            </span>
                            {!person.self && (
                                <>
                                    {/* A guest cannot be handed the room: they
                                        are a name typed into a link, and the
                                        host can end it, lock it and remove
                                        people. */}
                                    <Button
                                        size="icon-xs"
                                        variant="ghost"
                                        title={
                                            person.guest
                                                ? t("meetingRoom.onlySomebodyWithAPolaris")
                                                : t("meetingRoom.makeHost", { name: person.name })
                                        }
                                        aria-label={t("meetingRoom.makeHost", { name: person.name })}
                                        disabled={person.guest}
                                        onClick={async () => {
                                            const result = await runAction(
                                                () => transferHostAction(meetingId, person.id),
                                                onError
                                            );
                                            if (!result?.error) await onChanged();
                                        }}
                                    >
                                        <Crown className="size-3.5" />
                                    </Button>
                                    <Button
                                        size="icon-xs"
                                        variant="ghost"
                                        title={t("meetingRoom.removeNamed", { name: person.name })}
                                        aria-label={t("meetingRoom.removeNamed", { name: person.name })}
                                        onClick={() =>
                                            setRemoving({ id: person.id, name: person.name })
                                        }
                                    >
                                        <UserMinus className="size-3.5" />
                                    </Button>
                                </>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(next) => !next && setRemoving(null)}
                name={removing?.name ?? ""}
                kind="person"
                requireTyping={false}
                title={removing ? t("meetingRoom.removeQuestion", { name: removing.name }) : t("meetingRoom.removeThem")}
                question={t.rich("meetingRoom.removeConfirm", {
                    name: removing?.name ?? "",
                    strong: (chunks) => (
                        <span key="name" className="font-medium text-foreground">
                            {chunks}
                        </span>
                    )
                })}
                description={t("meetingRoom.theyAreDroppedFromThe")}
                confirmLabel={t("meetingRoom.remove")}
                onConfirm={async () => {
                    const person = removing;
                    setRemoving(null);
                    if (!person) return;
                    const result = await runAction(
                        () => removeFromMeetingAction(meetingId, person.id),
                        onError
                    );
                    if (!result?.error) await onChanged();
                }}
            />
        </section>
    );
}

/** Convene people who do have accounts. They are told through the bell: a
 *  meeting is usually for later, and ringing somebody about a room at four
 *  o'clock is the wrong instrument. */
function InviteDialog({
    open,
    meetingId,
    onClose,
    onInvited,
    onError
}: {
    open: boolean;
    meetingId: string;
    onClose: () => void;
    onInvited: () => void | Promise<void>;
    onError: (message: string) => void;
}) {
    const t = useTranslations("chat");
    const [picked, setPicked] = useState<readonly PickedPerson[]>([]);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (open) setPicked([]);
    }, [open]);

    return (
        <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("meetingRoom.invitePeople")}</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-2">
                    <p className="text-xs text-muted-foreground">
                        {t("meetingRoom.theyGetAnAlertWith")}
                    </p>
                    <PeoplePicker
                        picked={picked}
                        onChange={setPicked}
                        search={(query) => searchPeopleAction(query)}
                    />
                </div>
                <DialogFooter>
                    <Button variant="secondary" size="sm" onClick={onClose}>
                        {t("meetingRoom.cancel")}
                    </Button>
                    <Button
                        size="sm"
                        disabled={busy || picked.length === 0}
                        onClick={async () => {
                            setBusy(true);
                            const result = await runAction(
                                () =>
                                    inviteToMeetingAction({
                                        meetingId,
                                        userIds: picked.map((person) => person.id)
                                    }),
                                onError
                            );
                            setBusy(false);
                            if (!result?.error) {
                                await onInvited();
                                onClose();
                            }
                        }}
                    >
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        {t("meetingRoom.invite")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function Empty({ title, message }: { title: string; message: string }) {
    return (
        <div className={cn("flex min-h-0 flex-1 flex-col items-center justify-center gap-1 p-6")}>
            <p className="text-sm font-medium">{title}</p>
            <p className="text-xs text-muted-foreground">{message}</p>
        </div>
    );
}
