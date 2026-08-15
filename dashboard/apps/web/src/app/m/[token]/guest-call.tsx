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
import { CallRoom } from "@/app/(app)/chat/call-room";
import { PublicShell } from "@/components/public-shell";
import { Button, Card, CardBody, CardHeader, CardTitle, Input } from "@polaris/ui";
import { joinAsGuestAction, readCallAction } from "@/app/(app)/chat/meeting-actions";

/** How often the lobby asks whether it has been let in. Often enough not to feel
 *  stuck, rarely enough that a forgotten tab is not a load. */
const LOBBY_POLL_MS = 3000;

export function GuestCall({
    token,
    title,
    signedIn,
    suggestedName
}: {
    token: string;
    title: string;
    signedIn: boolean;
    /** Somebody who happens to be signed in still arrives here as a guest - the
     *  link is what they followed - so their name is offered rather than assumed. */
    suggestedName: string;
}) {
    const [name, setName] = useState(suggestedName);
    const [seat, setSeat] = useState<{ meetingId: string; admission: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const join = async () => {
        setBusy(true);
        setError("");
        const result = await joinAsGuestAction({ token, name });
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
            <div className="flex h-screen flex-col">
                <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
                    <Video className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{title || "Call"}</span>
                </header>
                <CallRoom
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
                                No account needed. Say who you are, and whoever is in the call
                                decides whether to let you in.
                            </p>
                            <Input
                                value={name}
                                autoFocus
                                maxLength={60}
                                aria-label="Your name"
                                placeholder="Your name"
                                onChange={(event) => setName(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter" && name.trim() && !busy) void join();
                                }}
                            />
                            {error && (
                                <p role="alert" className="text-sm text-destructive">
                                    {error}
                                </p>
                            )}
                            <Button
                                size="sm"
                                className="self-start"
                                disabled={busy || !name.trim()}
                                onClick={() => void join()}
                            >
                                {busy && <Loader2 className="size-4 animate-spin" />}
                                Ask to join
                            </Button>
                        </div>
                    )}
                </CardBody>
            </Card>
        </PublicShell>
    );
}
