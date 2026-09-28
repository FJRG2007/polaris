"use client";

/**
 * What to do about a change that only takes effect when the server comes back.
 *
 * The panel used to offer one answer - restart now - which is the wrong one
 * whenever anybody is playing, and the honest alternative was a sentence saying
 * "at the next start" and no way to make that happen. So this offers the three
 * answers people actually want: now, when the last person leaves, or at a time.
 *
 * Doing nothing is a real answer too, and it is written on the card: the change is
 * already saved, and the next start applies it whenever that is. Nothing here
 * restarts anything that was not asked for.
 *
 * Shown by every screen whose changes need a restart, so a server never learns two
 * different vocabularies for the same act.
 *
 * Once a restart is under way - pressed now, or a booked one that has just run -
 * the card says so until the screen that drew it hides it. Whatever it was about
 * (an update, a setting) is only in force once the server is back and has said
 * so, and until then the card used to offer the same three buttons again, which
 * read exactly like the press had been ignored.
 */

import * as actions from "./restart-actions";
import { hostUi } from "@polaris/app-host/client";
import { Button, Card, CardBody, Input } from "@polaris/ui";
import type { PendingRestart } from "../../lib/games-restart";
import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarClock, Loader2, RotateCcw, Users, X } from "lucide-react";

/** How long "restarting" is said for before the buttons come back: a server that
 *  is not back by then has a problem the card cannot describe, and somebody may
 *  want to press again. */
const RESTARTING_FOR_MS = 10 * 60_000;
/** How often a booked restart is asked about, to notice it has run. */
const WATCH_BOOKED_MS = 15_000;

const { RelativeTime } = hostUi.relativeTime;

export function RestartPlanner({
    installedAppId,
    running,
    changed,
    reason,
    title = "Saved, and not yet in force",
    detail = "The server reads this when it starts. Leave it and the next start picks it up; nothing is lost by waiting.",
    onRestarted
}: {
    installedAppId: string;
    /** A stopped server needs none of this: whatever was saved applies the next
     *  time somebody starts it. */
    running: boolean;
    /** Whether anything has been changed that is waiting for a restart. The card
     *  is drawn for that, or for a restart that is already booked. */
    changed: boolean;
    /** What changed, in a few words, so a booked restart can say why it exists a
     *  day later. */
    reason: string;
    /** What is waiting, for a change that is not a saved setting. */
    title?: string;
    detail?: string;
    onRestarted?: () => void;
}) {
    const [pending, setPending] = useState<PendingRestart | null>(null);
    const [busy, setBusy] = useState<"empty" | "at" | "now" | "cancel" | null>(null);
    /** When a restart began, as far as this screen knows. */
    const [restartingSince, setRestartingSince] = useState<number | null>(null);
    /** Whether a booking was last seen, so one that disappears can be told apart. */
    const booked = useRef(false);
    const [error, setError] = useState<string | null>(null);
    /** The time somebody is typing, while they are typing it. */
    const [at, setAt] = useState<string | null>(null);

    const load = useCallback(async () => {
        const answer = await actions.readGameRestartAction(installedAppId);
        // A booking that is gone without anybody calling it off here is one that ran.
        if (booked.current && !answer.pending) setRestartingSince(Date.now());
        booked.current = answer.pending !== null;
        setPending(answer.pending);
    }, [installedAppId]);

    useEffect(() => {
        void load();
    }, [load]);

    // Only while something is booked: that is the one state that changes on its
    // own, when the server empties or the time comes.
    useEffect(() => {
        if (!pending) return;
        const timer = setInterval(() => void load(), WATCH_BOOKED_MS);
        return () => clearInterval(timer);
    }, [pending, load]);

    useEffect(() => {
        if (restartingSince === null) return;
        const left = restartingSince + RESTARTING_FOR_MS - Date.now();
        const timer = setTimeout(() => setRestartingSince(null), Math.max(0, left));
        return () => clearTimeout(timer);
    }, [restartingSince]);

    async function book(when: "empty" | "at", moment?: string): Promise<void> {
        setBusy(when);
        setError(null);
        const answer = await actions.scheduleGameRestartAction({
            installedAppId,
            when,
            // A datetime-local field gives a wall-clock string with no zone; it is
            // this browser's clock, which is the one the person reading it is on.
            at: moment ? new Date(moment).toISOString() : null,
            reason
        });
        setBusy(null);
        if (answer.error || !answer.pending) {
            setError(answer.error ?? "That restart could not be booked");
            return;
        }
        booked.current = true;
        setPending(answer.pending);
        setAt(null);
    }

    async function now(): Promise<void> {
        setBusy("now");
        setError(null);
        const answer = await actions.restartGameNowAction(installedAppId);
        setBusy(null);
        if (answer.error) {
            setError(answer.error);
            return;
        }
        booked.current = false;
        setPending(null);
        setRestartingSince(Date.now());
        onRestarted?.();
    }

    async function cancel(): Promise<void> {
        setBusy("cancel");
        setError(null);
        const answer = await actions.cancelGameRestartAction(installedAppId);
        setBusy(null);
        if (answer.error) {
            setError(answer.error);
            return;
        }
        booked.current = false;
        setPending(null);
    }

    if (restartingSince !== null) {
        return (
            <Card>
                <CardBody className="flex items-center gap-2 py-3 text-sm" role="status">
                    <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                    <span>
                        <span className="font-medium">Restarting.</span>{" "}
                        <span className="text-muted-foreground">
                            Anybody playing is disconnected for a moment; the change is in force
                            once the server is back.
                        </span>
                    </span>
                </CardBody>
            </Card>
        );
    }

    if (!changed && !pending) return null;
    if (!running && !pending) {
        return (
            <Card>
                <CardBody className="py-3 text-sm text-muted-foreground">
                    Saved. The server is stopped, so this is what it will start with.
                </CardBody>
            </Card>
        );
    }

    return (
        <Card className="border-warning-edge bg-warning-soft">
            <CardBody className="flex flex-col gap-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">
                            {pending ? "A restart is booked" : title}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {pending ? (
                                pending.when === "empty" ? (
                                    <>
                                        It happens as soon as nobody is playing
                                        {pending.reason ? ` - ${pending.reason}` : ""}.
                                    </>
                                ) : (
                                    <>
                                        It happens <RelativeTime iso={pending.at ?? ""} />
                                        {pending.reason ? ` - ${pending.reason}` : ""}.
                                    </>
                                )
                            ) : (
                                detail
                            )}
                        </p>
                    </div>
                    {pending ? (
                        <Button variant="ghost" disabled={busy !== null} onClick={() => void cancel()}>
                            {busy === "cancel" ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                <X className="size-4" />
                            )}{" "}
                            Call it off
                        </Button>
                    ) : (
                        <div className="flex flex-wrap items-center gap-2">
                            <Button
                                variant="secondary"
                                disabled={busy !== null}
                                onClick={() => void book("empty")}
                            >
                                {busy === "empty" ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : (
                                    <Users className="size-4" />
                                )}{" "}
                                When nobody is playing
                            </Button>
                            <Button
                                variant="secondary"
                                disabled={busy !== null}
                                onClick={() => setAt((current) => (current === null ? "" : null))}
                            >
                                <CalendarClock className="size-4" /> At a time
                            </Button>
                            <Button disabled={busy !== null} onClick={() => void now()}>
                                {busy === "now" ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : (
                                    <RotateCcw className="size-4" />
                                )}
                                Restart now
                            </Button>
                        </div>
                    )}
                </div>

                {at !== null && !pending && (
                    <div className="flex flex-wrap items-center gap-2">
                        <Input
                            type="datetime-local"
                            className="w-56"
                            aria-label="When to restart"
                            value={at}
                            onChange={(event) => setAt(event.target.value)}
                        />
                        <Button
                            size="sm"
                            disabled={busy !== null || at.length === 0}
                            onClick={() => void book("at", at)}
                        >
                            {busy === "at" && <Loader2 className="size-4 animate-spin" />}
                            Book it
                        </Button>
                        <span className="text-xs text-muted-foreground">Your own clock.</span>
                    </div>
                )}

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}
            </CardBody>
        </Card>
    );
}
