"use client";

/**
 * Somebody is calling.
 *
 * Mounted by the dashboard shell rather than by Chat, and that is the point: a
 * call you only find out about by already looking at the conversation it is in
 * is not a call, it is a notice. Whoever is reading a log or a task board has to
 * be told, which is what every messenger does and what Polaris did not.
 *
 * It rings, once, for as long as a telephone would. The sound is synthesised
 * rather than fetched - see `call-sounds` - so it needs no asset and no network,
 * and it is refused rather than played on a tab the reader has never touched,
 * which is every browser's rule and not one worth fighting.
 *
 * Answering navigates and joins: the conversation's own screen is still the one
 * place that puts anybody into a room - it carries the answer in the address and
 * the screen acts on it - because two places that can open a microphone is how
 * one of them ends up with a camera nobody turned on.
 *
 * There are three answers to a ringing telephone and not two. Declining says no;
 * hushing it says "not now, and I have not decided" - which is what somebody in
 * a meeting does, and what every phone made in the last twenty years has a
 * button for. So the sound stops, the notice the operating system drew is taken
 * back, and the card stays exactly where it was.
 *
 * And a call nobody picked up leaves something behind. It used to vanish: the
 * ringing stopped, the card went, and whoever was called found out only if they
 * happened to open the conversation. Now the card turns into the missed call it
 * was, with the one thing anybody wants from it - a way to call back - and the
 * conversation keeps its own line about it. Both are needed: this is what is in
 * front of somebody who was at their desk, and the line is what is there
 * tomorrow.
 */

import Link from "next/link";
import { Avatar } from "./avatar";
import { Button } from "@polaris/ui";
import { useSessionScope } from "./session-scope";
import { claimForDevice } from "@/lib/device-once";
import { useHeldCall } from "@/app/(app)/chat/call-hold";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChatStream } from "@/app/(app)/chat/use-chat-stream";
import { leavesMissedCall, ringDecision, roomAfter, type RingRoom } from "@/lib/chat/ring-decision";
import {
    mayNotify,
    noticeStanding,
    notifyDesktop,
    tabIsWatched,
    type NoticeStanding
} from "@/lib/desktop-notify";
import { callElsewhereAction } from "@/app/(app)/chat/meeting-actions";
import { BellOff, Phone, PhoneMissed, PhoneOff, X } from "lucide-react";
import { openPeerChannel, type PeerChannel } from "@/lib/shared-stream";
import { RING_FOR_MS, playCallSound, startRinging, willBeHeard } from "@/lib/call-sounds";
import { CALLS_CHANNEL, callTabMessageSchema, type CallTabMessage } from "@/lib/chat/call-tabs";

/** How often a ringing telephone checks whether it was answered somewhere else.
 *  Only ever while one is ringing, so it costs nothing the rest of the time. */
const SEAT_CHECK_MS = 4_000;

/** A call that rang here and was never answered. Kept until it is dismissed:
 *  the whole failing this replaces was a notice that took itself away before
 *  anybody came back to their desk. */
interface Missed {
    readonly channelId: string;
    readonly meetingId: string;
    readonly name: string;
    readonly userId: string;
    /** When it stopped ringing, for the line under the name. */
    readonly at: number;
}

/** How many of them are drawn at once. Past a few this stops being a notice and
 *  becomes a pile; the bell and the conversation both keep the rest. */
const MOST_MISSED = 3;

interface Ringing {
    readonly channelId: string;
    readonly meetingId: string;
    /** Who started it. Empty where the server had no name to give, which is
     *  every case except a person pressing the button. */
    readonly name: string;
    /** Their account, for the face on the card. A name on its own is read; a
     *  face is recognised, which is the whole of what somebody deciding whether
     *  to answer is doing. */
    readonly userId: string;
    readonly at: number;
}

export function IncomingCalls({ viewerId }: { viewerId: string }) {
    const scope = useSessionScope();
    const held = useHeldCall();
    const [ringing, setRinging] = useState<readonly Ringing[]>([]);
    const [missed, setMissed] = useState<readonly Missed[]>([]);
    // Hushed here or in another tab of this browser. Kept apart from the ringing
    // list because it outlives nothing: a call that is silenced is still a call
    // being offered, and only the sound has been dealt with.
    const [silenced, setSilenced] = useState<readonly string[]>([]);
    const inCall = held?.session?.meetingId ?? null;
    /** And which conversation that call belongs to, which is what says whether a
     *  missed call is still missed. */
    const inChannel = held?.session?.channelId ?? null;
    /**
     * Whether Polaris may reach past this window at all.
     *
     * A missed call is the moment this is worth saying: somebody was somewhere
     * else and nothing reached them, and the reason is usually that this browser
     * has never been asked. Read on mount, because none of it exists on the
     * server, and starting at "granted" so a card that has not read it yet
     * offers nothing rather than flashing an offer at somebody who already said
     * yes.
     */
    const [standing, setStanding] = useState<NoticeStanding>("granted");
    useEffect(() => setStanding(noticeStanding()), []);

    /**
     * How full each ringing room was, and whether anybody walked into it.
     *
     * The one fact this card cannot work out for itself. "It left my list and I
     * did not answer it" is not what a missed call is - the server's rule is
     * that somebody other than the caller sat in it, and by that rule a group
     * call Bob picked up is a call, not three missed ones. Without this, every
     * other person rung was left with a persistent card and a Call back button
     * for a conversation that was answered and may still be running.
     *
     * Read off the frames, which carry the seat count. The caller is already
     * seated when it starts ringing, so the count at that moment is the room
     * with nobody having answered yet, and anything above it afterwards is
     * somebody who did.
     */
    const seats = useRef(new Map<string, RingRoom>());

    const drop = useCallback((meetingId: string) => {
        seats.current.delete(meetingId);
        setRinging((current) => current.filter((entry) => entry.meetingId !== meetingId));
    }, []);

    /**
     * The other tabs of this browser, told when a call has been dealt with here.
     *
     * One telephone, however many windows it is drawn in. A call answered in one
     * tab used to leave every other tab holding a card that offered to join it,
     * the tab holding the connection still ringing, and the notice the operating
     * system had drawn still up - all of it until a reload, which is not
     * something anybody does with a telephone in their hand.
     */
    const peers = useRef<PeerChannel<CallTabMessage> | null>(null);
    useEffect(() => {
        const channel = openPeerChannel<CallTabMessage>(CALLS_CHANNEL, scope, (message) => {
            const parsed = callTabMessageSchema.safeParse(message);
            if (!parsed.success) return;
            // Hushed next door is hushed here: one telephone, however many
            // windows it is drawn in. The card stays in all of them, because
            // silence is not an answer.
            if (parsed.data.kind === "silenced") {
                setSilenced((current) =>
                    current.includes(parsed.data.meetingId) ? current : [...current, parsed.data.meetingId]
                );
                return;
            }
            drop(parsed.data.meetingId);
        });
        peers.current = channel;
        return () => {
            peers.current = null;
            channel.close();
        };
    }, [drop, scope]);

    /** What is ringing right now, readable from a timer and from a frame handler
     *  without either of them having to be rebuilt every time the list changes. */
    const live = useRef<readonly Ringing[]>([]);
    useEffect(() => {
        live.current = ringing;
    }, [ringing]);

    /**
     * A missed call from the conversation you are now in is not a missed call.
     *
     * Read from a ref by `missedOut`, which is memoized and must not be rebuilt
     * every time a call is joined or left, and swept here for the other order:
     * the card left by the first attempt is already on screen when the second
     * one is answered, and it sat there afterwards saying "missed call" over a
     * conversation the reader was in the middle of having. Answering IS the
     * answer to it, whichever of the two happened first.
     */
    const inChannelNow = useRef<string | null>(null);
    useEffect(() => {
        inChannelNow.current = inChannel;
        if (!inChannel) return;
        setMissed((current) =>
            current.some((one) => one.channelId === inChannel)
                ? current.filter((one) => one.channelId !== inChannel)
                : current
        );
    }, [inChannel]);

    /**
     * A call that went away without being answered.
     *
     * The difference from `settle` is the whole of what a missed call is: settled
     * means somebody here dealt with it - answered it, declined it, picked it up
     * on their phone - and this means nobody did and it stopped. Only the second
     * leaves anything behind.
     *
     * Nothing is recorded for a call that was already gone from the list, which
     * is what the frame announcing the end of an answered call would otherwise
     * do: it arrives in every tab, including the one that answered.
     *
     * And nothing is recorded for a call somebody else answered. Not answering a
     * call three people were rung about and one of them took is not missing it,
     * which is the rule the server writes the conversation's line by - so a card
     * saying otherwise would be this browser contradicting the only record of it
     * that lasts.
     */
    const missedOut = useCallback(
        (meetingId: string) => {
            const entry = live.current.find((one) => one.meetingId === meetingId);
            const answered = seats.current.get(meetingId)?.answered ?? false;
            drop(meetingId);
            if (!entry) return;
            // Decided in one pure place, for the same reason ringing is: what is
            // owed a card is a rule, and a rule inside a component is one
            // nothing can ask a question of. See `leavesMissedCall`.
            const owed = leavesMissedCall({
                wasRinging: true,
                answered,
                channelId: entry.channelId,
                inChannelId: inChannelNow.current
            });
            if (!owed) return;
            setMissed((current) =>
                [
                    { ...entry, at: Date.now() },
                    ...current.filter((one) => one.meetingId !== meetingId)
                ].slice(0, MOST_MISSED)
            );
        },
        [drop]
    );

    const forget = useCallback(
        (meetingId: string) => setMissed((current) => current.filter((one) => one.meetingId !== meetingId)),
        []
    );

    /** Put a call down here, and everywhere else this browser is drawing it. */
    const settle = useCallback(
        (meetingId: string) => {
            drop(meetingId);
            peers.current?.post({ kind: "settled", meetingId });
        },
        [drop]
    );

    /**
     * Stop the sound, keep the call.
     *
     * The middle answer, and the one a ringing telephone has always had: not
     * now, and not no. The notice the operating system drew goes with the sound -
     * it is the same interruption in another form - and the card stays, because
     * nothing has been decided yet.
     */
    const hush = useCallback((meetingId: string) => {
        setSilenced((current) => (current.includes(meetingId) ? current : [...current, meetingId]));
        peers.current?.post({ kind: "silenced", meetingId });
    }, []);

    /**
     * Answered, wherever in Polaris that happened.
     *
     * The card is one way in and deliberately not the only one: the conversation
     * has a Join, the voice room has a strip, and a call picked up in any of them
     * is a call the other tabs must stop asking about. Being in it is the fact
     * they all need, so it is the one that is said out loud.
     */
    useEffect(() => {
        if (inCall) settle(inCall);
    }, [inCall, settle]);

    /**
     * Answered on another device, asked rather than waited for.
     *
     * There is a frame that says so - joining announces itself, carrying who
     * joined - and while everything is well it arrives and this costs nothing.
     * What it does not survive is not arriving: a phone with its screen off has
     * a stream the operating system has suspended, and it wakes up ringing about
     * a call that was answered on the desk five minutes ago. That is the thing
     * everybody notices about a house with more than one telephone, and it is
     * not something to leave to a message.
     *
     * So while anything is ringing, and only then, the account is asked where
     * its seat is. On a timer and again the moment the tab comes back, which is
     * exactly when somebody is looking at the phone that should have stopped.
     */
    useEffect(() => {
        if (ringing.length === 0) return;
        let stopped = false;

        async function ask(): Promise<void> {
            const elsewhere = await callElsewhereAction().catch(() => null);
            if (stopped || !elsewhere) return;
            settle(elsewhere.meetingId);
        }

        function onVisible(): void {
            if (document.visibilityState === "visible") void ask();
        }

        void ask();
        const timer = setInterval(() => void ask(), SEAT_CHECK_MS);
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            stopped = true;
            clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [ringing.length, settle]);

    useChatStream(
        useCallback(
            (frame) => {
                if (frame.kind !== "call") return;
                // Who is in the room, before anything is decided about it: the
                // decision below cannot see this, and it is what tells a call
                // nobody answered from one somebody else did.
                const room = roomAfter(seats.current.get(frame.meetingId), frame);
                if (room) seats.current.set(frame.meetingId, room);
                // What the frame means is decided in one pure place, because
                // "should this still be ringing" is the question and none of
                // what is needed to draw a ringing card can be asked it. See
                // `ring-decision`.
                switch (ringDecision(frame, viewerId)) {
                    case "ring":
                        setRinging((current) =>
                            current.some((entry) => entry.meetingId === frame.meetingId)
                                ? current
                                : [
                                      ...current,
                                      {
                                          channelId: frame.channelId,
                                          meetingId: frame.meetingId,
                                          name: frame.name,
                                          userId: frame.userId,
                                          at: Date.now()
                                      }
                                  ]
                        );
                        return;
                    case "settle":
                        // Picked up on another of this person's devices. Told to
                        // the other tabs of this browser through the same
                        // channel one of them answering would have used, so the
                        // card goes, the ringing stops, and the notice the
                        // operating system drew is taken back with it.
                        settle(frame.meetingId);
                        return;
                    case "drop":
                        // Over, and this browser never picked it up: the caller
                        // gave up, or the room emptied. That is a missed call,
                        // and `missedOut` is what tells the two apart.
                        missedOut(frame.meetingId);
                        return;
                    case "ignore":
                        return;
                }
            },
            [missedOut, settle, viewerId]
        )
    );

    /**
     * Everything still worth being told about, drawn wherever the reader is
     * standing.
     *
     * A call this browser is already sitting in is not an incoming call - it is
     * the call - and that is the only thing left out.
     *
     * It used to also skip the conversation the call is in, on the reasoning
     * that the room is right there with its own way in. That reasoning was
     * wrong, and it was wrong in the case that matters most. What actually
     * changed on that screen when a call came in was a small button in the
     * header growing a number - above the messages somebody was reading, in the
     * corner they were not looking at, with no green button anywhere and no way
     * to answer that did not involve noticing it. A call arriving is exactly the
     * moment a chat is allowed to interrupt, and the answer is the one a
     * telephone gives: put it in front of them.
     */
    const showing = ringing.filter((entry) => entry.meetingId !== inCall);

    /**
     * One ring for however many are waiting, and silence once none are.
     *
     * One ring for however many tabs, too. The tabs of a browser settle between
     * themselves which of them rings a given call and the rest stay silent - a
     * telephone that rings once per open tab is a telephone people mute. It is
     * settled by claim rather than by which tab holds the live connection,
     * because on an install served over plain http every tab holds one of its
     * own and so every tab believes it is the one; see `device-once`.
     *
     * The claim is held for as long as the call is allowed to ring, so a tab
     * opened halfway through does not join in, and it is remembered here so that
     * a re-render deciding to ring the same call again asks nobody a second time.
     */
    const sounding = showing.find((entry) => !silenced.includes(entry.meetingId))?.meetingId ?? null;
    /**
     * Which tab of this device answers for a call: its sound AND its notice.
     *
     * One claim for both, because they are one decision. With a claim each they
     * could fall to different tabs, and then the tab ringing and the tab drawing
     * the notice each believed the other was making the sound: the ringing tab
     * was one the browser had never let start its audio, the notice tab could
     * have made a noise and stayed silent because "the ring is already
     * sounding", and the call arrived in silence. Whoever holds this knows
     * whether its own ring can be heard, which is the only place that question
     * has an answer.
     */
    const mine = useRef(new Map<string, Promise<boolean>>());
    const alertClaim = useCallback(
        (meetingId: string): Promise<boolean> => {
            const held = mine.current.get(meetingId);
            if (held) return held;
            const claim = claimForDevice(`${scope}:ring:${meetingId}`, RING_FOR_MS);
            mine.current.set(meetingId, claim);
            return claim;
        },
        [scope]
    );

    useEffect(() => {
        if (!sounding) return;
        let stop: (() => void) | null = null;
        let dropped = false;
        void alertClaim(sounding).then((ours) => {
            if (ours && !dropped) stop = startRinging("ring");
        });
        return () => {
            dropped = true;
            stop?.();
        };
    }, [alertClaim, sounding]);

    /**
     * Reach past the browser window.
     *
     * The card is drawn in every tab, but a tab is not where somebody is: they
     * are in an editor, or in another window entirely, and a call that only
     * exists inside a page nobody is looking at is a missed call. This is the
     * one thing a browser has that the operating system draws.
     *
     * Once for the device however many tabs it has open, and taken back the
     * moment the call is answered or gives up - a notice offering to join a room
     * that is already over is worse than none.
     *
     * **Drawn whenever this tab cannot ring, and not only when nobody is looking
     * at it.** "Looking at the tab" is `document.visibilityState`, which says a
     * window is on screen and nothing about whether anybody has read a word of
     * it: a Polaris left open on a second screen, or behind an editor, is
     * "visible" and untouched, and a browser refuses audio to a page nobody has
     * interacted with. That combination - on screen, never pressed - took the
     * device's one claim and then made no sound at all, drew nothing outside the
     * window because it believed somebody was reading it, and the call passed in
     * silence with its card on a screen nobody was facing. So the question is not
     * where the tab is, it is whether this tab can be heard.
     */
    const notices = useRef(new Map<string, { close: () => void }>());
    useEffect(() => {
        for (const entry of showing) {
            if (notices.current.has(entry.meetingId)) continue;
            // A hushed call raises nothing outside the window either. The
            // operating system's notice is the same interruption in another
            // form, and somebody who has just silenced one has said so.
            if (silenced.includes(entry.meetingId)) continue;
            // Marked before the claim, the audio and the permission prompt
            // resolve, so a second frame does not raise a second notice for the
            // same call.
            notices.current.set(entry.meetingId, { close: () => undefined });
            void alertClaim(entry.meetingId).then(async (ours) => {
                if (!ours) return;
                // Asked once, after the ring has had its chance to start, and
                // used for both halves of the decision below - see `willBeHeard`
                // for why the answer has to be waited for rather than read.
                const heard = await willBeHeard();
                // A tab being read, ringing audibly, needs nothing drawn over the
                // top of it.
                if (heard && tabIsWatched()) return;
                const notice = await notifyDesktop({
                    title: `${entry.name || "Somebody"} is calling`,
                    body: "Answer in Polaris",
                    tag: `call:${entry.meetingId}`,
                    href: `/chat/c/${entry.channelId}`,
                    insistent: true,
                    // The one notice in Polaris that may ring - and only where
                    // the ring itself cannot be heard, which is the whole reason
                    // this tab is drawing one. Where the ring has been allowed,
                    // it is already sounding and a chime over the top of it is
                    // two noises for one call.
                    sound: !heard
                });
                if (notice) notices.current.set(entry.meetingId, notice);
            });
        }

        const live = new Set(
            showing.filter((entry) => !silenced.includes(entry.meetingId)).map((entry) => entry.meetingId)
        );
        for (const [meetingId, notice] of notices.current) {
            if (live.has(meetingId)) continue;
            notice.close();
            notices.current.delete(meetingId);
        }
        // The same for what this tab decided about ringing each of them: a call
        // that is over is not one anybody asks about again, and a browser left
        // open for a week would otherwise keep every answer it ever gave.
        for (const meetingId of mine.current.keys()) {
            if (!live.has(meetingId)) mine.current.delete(meetingId);
        }
    }, [alertClaim, showing, silenced]);

    // Nothing outlives the screen: a notice left behind by a page that has gone
    // is one nobody can dismiss from inside Polaris.
    useEffect(() => {
        const open = notices.current;
        return () => {
            for (const notice of open.values()) notice.close();
            open.clear();
        };
    }, []);

    // A call nobody answered stops asking. The same span the sound gives up
    // after, so the card never sits there silent - and what it becomes is the
    // missed call it was, rather than nothing at all.
    useEffect(() => {
        if (ringing.length === 0) return;
        const timer = setInterval(() => {
            const cutoff = Date.now() - RING_FOR_MS;
            for (const entry of live.current) {
                if (entry.at <= cutoff) missedOut(entry.meetingId);
            }
        }, 1000);
        return () => clearInterval(timer);
    }, [ringing.length, missedOut]);

    if (showing.length === 0 && missed.length === 0) return null;

    return (
        <div className="flex flex-col gap-2">
            {missed.map((entry, index) => (
                <div
                    key={entry.meetingId}
                    role="status"
                    className="pointer-events-auto flex w-72 flex-col gap-3 rounded-lg border border-border bg-elevated p-3 shadow-modal"
                >
                    <span className="flex items-center gap-2.5">
                        <Avatar size={36} person={{ id: entry.userId, name: entry.name || "Somebody" }} />
                        <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                                {entry.name || "Somebody"}
                            </span>
                            <span className="block text-xs text-muted-foreground">Missed call</span>
                        </span>
                        <PhoneMissed className="size-4 shrink-0 text-danger" aria-hidden />
                    </span>
                    {/* Why it may not have been heard, on the one card that is
                        evidence of it, and only on the first of them - three
                        missed calls do not need telling three times. Offered
                        here rather than left on a settings screen nobody visits
                        until after the call they missed. */}
                    {index === 0 && standing === "askable" ? (
                        <button
                            type="button"
                            className="text-left text-xs text-primary hover:underline"
                            onClick={() =>
                                void mayNotify().finally(() => setStanding(noticeStanding()))
                            }
                        >
                            Polaris can only ring this tab. Let it reach you anywhere.
                        </button>
                    ) : index === 0 && standing === "denied" ? (
                        <span className="text-xs text-muted-foreground">
                            This browser is blocking Polaris' notices, so a call can only ring in
                            this tab.{" "}
                            <Link className="text-primary hover:underline" href="/account/notifications">
                                What to do about it
                            </Link>
                        </span>
                    ) : null}
                    <span className="flex items-center gap-2">
                        <Button
                            asChild
                            size="sm"
                            variant="secondary"
                            className="flex-1"
                            onClick={() => forget(entry.meetingId)}
                        >
                            {/* The same address answering uses. What it names is
                                over, and that is fine: the conversation's screen
                                reads it as "put me in this room's call", which
                                starts one when there is none - which is exactly
                                what calling somebody back is. */}
                            <Link href={`/chat/c/${entry.channelId}?answer=${entry.meetingId}`}>
                                <Phone className="size-4" />
                                Call back
                            </Link>
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            aria-label="Dismiss"
                            title="Dismiss"
                            onClick={() => forget(entry.meetingId)}
                        >
                            <X className="size-4" />
                        </Button>
                    </span>
                </div>
            ))}
            {showing.map((entry) => (
                <div
                    key={entry.meetingId}
                    role="alert"
                    className="pointer-events-auto flex w-72 flex-col gap-3 rounded-lg border border-border-strong bg-elevated p-3 shadow-modal"
                >
                    <span className="flex items-center gap-2.5">
                        <Avatar
                            size={36}
                            person={{ id: entry.userId, name: entry.name || "Somebody" }}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {entry.name || "Somebody"} is calling
                        </span>
                        <Phone className="size-4 shrink-0 animate-pulse text-success" />
                    </span>
                    <span className="flex items-center gap-2">
                        <Button
                            asChild
                            size="sm"
                            className="flex-1"
                            onClick={() => settle(entry.meetingId)}
                        >
                            {/* Answering answers. The conversation is still
                                where the room is drawn, but arriving there and
                                having to press Join is a second decision nobody
                                made - they pressed the green button. The
                                microphone only: a camera is never opened by
                                anything but a press that says so. */}
                            <Link href={`/chat/c/${entry.channelId}?answer=${entry.meetingId}`}>
                                <Phone className="size-4" />
                                Answer
                            </Link>
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            aria-label="Silence the ring"
                            title="Silence the ring"
                            disabled={silenced.includes(entry.meetingId)}
                            onClick={() => hush(entry.meetingId)}
                        >
                            <BellOff className="size-4" />
                        </Button>
                        <Button
                            size="sm"
                            variant="danger"
                            aria-label="Decline"
                            title="Decline"
                            onClick={() => {
                                // Declined here and nowhere else: the caller is
                                // not told, because a missed call and a refused
                                // one look the same from the other end and
                                // Polaris has no business saying which it was.
                                playCallSound("hangUp");
                                settle(entry.meetingId);
                            }}
                        >
                            <PhoneOff className="size-4" />
                        </Button>
                    </span>
                </div>
            ))}
        </div>
    );
}
