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
 */

import * as actions from "./restart-actions";
import { useCallback, useEffect, useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import { Button, Card, CardBody, Input } from "@polaris/ui";
import type { PendingRestart } from "@/lib/apps/games-restart";
import { CalendarClock, Loader2, RotateCcw, Users, X } from "lucide-react";

export function RestartPlanner({
    installedAppId,
    running,
    changed,
    reason,
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
    onRestarted?: () => void;
}) {
    const [pending, setPending] = useState<PendingRestart | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** The time somebody is typing, while they are typing it. */
    const [at, setAt] = useState<string | null>(null);

    const load = useCallback(async () => {
        const answer = await actions.readGameRestartAction(installedAppId);
        setPending(answer.pending);
    }, [installedAppId]);

    useEffect(() => {
        void load();
    }, [load]);

    async function book(when: "empty" | "at", moment?: string): Promise<void> {
        setBusy(true);
        setError(null);
        const answer = await actions.scheduleGameRestartAction({
            installedAppId,
            when,
            // A datetime-local field gives a wall-clock string with no zone; it is
            // this browser's clock, which is the one the person reading it is on.
            at: moment ? new Date(moment).toISOString() : null,
            reason
        });
        setBusy(false);
        if (answer.error || !answer.pending) {
            setError(answer.error ?? "That restart could not be booked");
            return;
        }
        setPending(answer.pending);
        setAt(null);
    }

    async function now(): Promise<void> {
        setBusy(true);
        setError(null);
        const answer = await actions.restartGameNowAction(installedAppId);
        setBusy(false);
        if (answer.error) {
            setError(answer.error);
            return;
        }
        setPending(null);
        onRestarted?.();
    }

    async function cancel(): Promise<void> {
        setBusy(true);
        setError(null);
        const answer = await actions.cancelGameRestartAction(installedAppId);
        setBusy(false);
        if (answer.error) {
            setError(answer.error);
            return;
        }
        setPending(null);
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
        <Card className="border-warning/40 bg-warning/5">
            <CardBody className="flex flex-col gap-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">
                            {pending ? "A restart is booked" : "Saved, and not yet in force"}
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
                                "The server reads this when it starts. Leave it and the next start picks it up; nothing is lost by waiting."
                            )}
                        </p>
                    </div>
                    {pending ? (
                        <Button variant="ghost" disabled={busy} onClick={() => void cancel()}>
                            <X className="size-4" /> Call it off
                        </Button>
                    ) : (
                        <div className="flex flex-wrap items-center gap-2">
                            <Button variant="secondary" disabled={busy} onClick={() => void book("empty")}>
                                <Users className="size-4" /> When nobody is playing
                            </Button>
                            <Button
                                variant="secondary"
                                disabled={busy}
                                onClick={() => setAt((current) => (current === null ? "" : null))}
                            >
                                <CalendarClock className="size-4" /> At a time
                            </Button>
                            <Button disabled={busy} onClick={() => void now()}>
                                {busy ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
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
                            disabled={busy || at.length === 0}
                            onClick={() => void book("at", at)}
                        >
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
