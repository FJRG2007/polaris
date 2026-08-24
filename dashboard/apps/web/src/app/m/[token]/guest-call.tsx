"use client";

/**
 * The three states of arriving at a call on a link.
 *
 * Say who you are, wait to be let in, and then the call. They are one component
 * because they are one flow with one piece of state moving through it, and
 * because the middle one has to keep polling to find out that it has ended - a
 * lobby that never notices it was admitted is the worst version of this screen.
 *
 * The call itself is the same component the dashboard uses. A guest is in the
 * same room, not a lesser copy of it.
 */

import { useEffect, useState } from "react";
import { Loader2, Video } from "lucide-react";
import { useCall } from "@/app/(app)/chat/use-call";
import { CallRoom } from "@/app/(app)/chat/call-room";
import { CallAudio } from "@/app/(app)/chat/call-audio";
import { MeetingChat } from "@/app/(app)/chat/meeting-chat";
import { PublicShell } from "@/components/public-shell";
import { Button, Card, CardBody, CardHeader, CardTitle, Input } from "@polaris/ui";
import {
    joinAsGuestAction,
    joinOnLinkAction,
    readCallAction
} from "@/app/(app)/chat/meeting-actions";

/** How often the lobby asks whether it has been let in. Often enough not to feel
 *  stuck, rarely enough that a forgotten tab is not a load. */
const LOBBY_POLL_MS = 3000;

export function GuestCall({
    token,
    title,
    signedIn,
    suggestedName,
    asAccount = false
}: {
    token: string;
    title: string;
    signedIn: boolean;
    /** Somebody who happens to be signed in still arrives here as a guest - the
     *  link is what they followed - so their name is offered rather than assumed. */
    suggestedName: string;
    /** The host asked for accounts, and this reader has one. There is no name to
     *  ask for: they arrive as themselves, which is the point of the setting. */
    asAccount?: boolean;
}) {
    const [name, setName] = useState(suggestedName);
    const [seat, setSeat] = useState<{ meetingId: string; admission: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const join = async () => {
        setBusy(true);
        setError("");
        const result = asAccount
            ? await joinOnLinkAction(token)
            : await joinAsGuestAction({ token, name });
        setBusy(false);
        if (result.error || !result.meetingId) {
            setError(result.error ?? "That did not work");
            return;
        }
        setSeat({ meetingId: result.meetingId, admission: result.admission ?? "admitted" });
    };

    // Waiting at the door. The seat is re-read rather than pushed, because the
    // signalling stream deliberately tells somebody in the lobby nothing.
    useEffect(() => {
        if (!seat || seat.admission !== "waiting") return;
        const timer = setInterval(async () => {
            const result = await readCallAction(seat.meetingId);
            const me = result.meeting?.participants.find(
                (person) => person.id === result.participantId
            );
            if (!me) return;
            if (me.admission === "admitted") setSeat({ ...seat, admission: "admitted" });
            if (me.admission === "denied") {
                setSeat(null);
                setError("Somebody in the call turned the request down.");
            }
        }, LOBBY_POLL_MS);
        return () => clearInterval(timer);
    }, [seat]);

    if (seat?.admission === "admitted") {
        return (
            <div className="flex h-screen flex-col overflow-hidden">
                <GuestRoom
                    title={title}
                    meetingId={seat.meetingId}
                    onLeave={() => {
                        setSeat(null);
                        setError("You have left the call.");
                    }}
                />
            </div>
        );
    }

    return (
        <PublicShell signedIn={signedIn}>
            <Card>
                <CardHeader>
                    <CardTitle>{title || "Join the call"}</CardTitle>
                </CardHeader>
                <CardBody>
                    {seat?.admission === "waiting" ? (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                            <Loader2 className="size-4 animate-spin" />
                            Waiting for somebody in the call to let you in.
                        </p>
                    ) : (
                        <div className="flex flex-col gap-3">
                            <p className="text-sm text-muted-foreground">
                                {asAccount
                                    ? "The host asked for Polaris accounts, so you are joining under your own name."
                                    : "No account needed. Say who you are, and whoever is in the call decides whether to let you in."}
                            </p>
                            {!asAccount && (
                                <Input
                                    value={name}
                                    autoFocus
                                    maxLength={60}
                                    aria-label="Your name"
                                    placeholder="Your name"
                                    onChange={(event) => setName(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" && name.trim() && !busy) {
                                            void join();
                                        }
                                    }}
                                />
                            )}
                            {error && (
                                <p role="alert" className="text-sm text-danger">
                                    {error}
                                </p>
                            )}
                            <Button
                                size="sm"
                                className="self-start"
                                disabled={busy || (!asAccount && !name.trim())}
                                onClick={() => void join()}
                            >
                                {busy && <Loader2 className="size-4 animate-spin" />}
                                {asAccount ? "Join" : "Ask to join"}
                            </Button>
                        </div>
                    )}
                </CardBody>
            </Card>
        </PublicShell>
    );
}

/**
 * A guest's own call.
 *
 * The dashboard holds one call above every screen, and a guest has no
 * dashboard - one page, one room, and leaving it is closing the tab. So this is
 * where their call lives.
 */
function GuestRoom({
    meetingId,
    title,
    onLeave
}: {
    meetingId: string;
    /** What the link said it was called. The room's own copy wins once it
     *  arrives, so a host renaming the meeting reaches the guest too rather than
     *  leaving them on the name the page was built with. */
    title: string;
    onLeave: () => void;
}) {
    const call = useCall(meetingId, { video: true });
    return (
        <>
            <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
                <Video className="size-4 text-muted-foreground" />
                <span className="truncate text-sm font-medium">
                    {call.meeting?.title || title || "Call"}
                </span>
            </header>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
                {/* The room, played. In the dashboard this is mounted beside the
                    call so it survives walking away from the conversation; here
                    there is nowhere to walk, and it still has to be mounted by
                    somebody - the tiles carry the picture and nothing else. */}
                <CallAudio call={call} />
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    <CallRoom meetingId={meetingId} call={call} onLeave={onLeave} />
                </div>
                {/* The same column an account gets. A guest is in the same room, not
                    a lesser copy of it - and they are the person most likely to be
                    sent an address in it. */}
                <aside className="flex min-h-0 w-full shrink-0 flex-col border-t border-border lg:w-80 lg:border-l lg:border-t-0">
                    <MeetingChat meetingId={meetingId} call={call} className="flex-1" />
                </aside>
            </div>
        </>
    );
}
