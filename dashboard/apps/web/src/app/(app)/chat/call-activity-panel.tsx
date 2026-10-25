"use client";

/**
 * Games in a call: the button that starts one, the line that offers it to
 * everybody else, and the game itself, drawn inside the call by the app that
 * offers it (its `call-activity` slot).
 *
 * What is synced, and nothing more: who is playing (each player's own claim,
 * vouched for by the server) and each player's position, heading and vehicle,
 * passed only between the players. Every browser runs its own city; traffic,
 * people on the street and everything else in it are not shared.
 *
 * The game's code loads only once somebody plays. The server is asked once as
 * the reader takes their seat whether they may play, so the button is drawn
 * only for whoever may use it.
 */

import type { CallState } from "./call-state";
import {
    Expand,
    Joystick,
    LogOut,
    Maximize2,
    Minimize2,
    Rocket,
    Shrink,
    UserPlus
} from "lucide-react";
import { onActivityJoin, takeActivityJoin } from "./activity-join";
import * as actions from "./call-activity-actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { CallActivityHost } from "@/lib/app-extensions/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppSlotView } from "@/components/app-extensions/installed-client";
import { Avatar } from "@/components/avatar";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    cn
} from "@polaris/ui";
import * as callGame from "@/lib/chat/call-activity";

export interface CallActivity {
    readonly session: callGame.ActivitySession | null;
    readonly mine: callGame.ActivityClaim | null;
    readonly playing: boolean;
    readonly answer: actions.CallGamesAnswer | null;
    readonly busy: boolean;
    readonly gameName: (id: string) => string | null;
    readonly nameOf: (seat: string) => string;
    readonly ask: () => void;
    readonly play: (game: string) => void;
    readonly leave: () => void;
    /** What the game is handed while the reader plays. */
    readonly host: CallActivityHost | null;
    /** Whether the game has the call's big place, the faces a strip under it. */
    readonly focused: boolean;
    readonly setFocused: (focused: boolean) => void;
}

/**
 * What the game needs from the room it is played in: who is there and what
 * each of them claims, a way to say this seat's claim, and the data channel
 * positions travel on. A call provides it (`use-sfu-call`), and so does a
 * lobby's data-only room (`use-lobby-room`).
 */
export type ActivityTransport = Pick<
    CallState,
    "participantId" | "setActivity" | "sendActivity" | "listenActivity"
> & {
    readonly states: ReadonlyMap<string, { readonly activity?: string }>;
    readonly meeting: {
        readonly participants: readonly { readonly id: string; readonly name: string }[];
    } | null;
};

/** The server's side of playing: the same five questions for a call and for
 *  a lobby, each keyed by the room's id. */
export type ActivityApi = Pick<
    typeof actions,
    "callGames" | "claimCallGame" | "renewCallGame" | "leaveCallGame" | "vouchCallGames"
>;

/** How far the server's clock is ahead of this browser's, read off a pass it
 *  has just minted. */
function skewFrom(claim: callGame.ActivityClaim): number {
    return callGame.passExpiresAt(claim.pass) - callGame.PASS_TTL_MS - Date.now();
}

/** Everything a call needs to play together, for the button, the line and the
 *  frame to share. */
/** Off for a guest, who has no account to hold `arcade.calls` with. */
export function useCallActivity(
    meetingId: string,
    call: ActivityTransport,
    enabled: boolean,
    /** Who decides: the call's actions, or a lobby's (`lobby-actions`). */
    api: ActivityApi = actions
): CallActivity {
    const self = call.participantId ?? "";
    const [mine, setMine] = useState<callGame.ActivityClaim | null>(null);
    const [vouched, setVouched] = useState<ReadonlySet<string>>(new Set());
    const [answer, setAnswer] = useState<actions.CallGamesAnswer | null>(null);
    const [busy, setBusy] = useState(false);
    const asking = useRef(false);
    const { setActivity } = call;
    // The moment claims are judged against, so a pass that ran out stops
    // counting without anybody having to say so. On the server's clock: a
    // pass runs out by its time, not by this browser's.
    const [skew, setSkew] = useState(0);
    const [tick, setTick] = useState(() => Date.now());
    const clock = tick + skew;
    const anyClaims = call.states.size > 0 && enabled;
    useEffect(() => {
        if (!anyClaims) return;
        const timer = window.setInterval(() => setTick(Date.now()), 30_000);
        return () => window.clearInterval(timer);
    }, [anyClaims]);

    const claims = useMemo(() => {
        const found = new Map<string, callGame.ActivityClaim>();
        if (!enabled) return found;
        for (const [seat, state] of call.states) {
            const claim = callGame.readClaim({ activity: state.activity ?? "" });
            if (claim) found.set(seat, claim);
        }
        return found;
    }, [call.states, enabled]);

    // Ask the server once per claim whether it minted it; a claim it did not
    // mint counts for nothing.
    const checked = useRef(new Map<string, boolean>());
    const claimKey = (seat: string, claim: callGame.ActivityClaim) => `${seat}|${claim.pass}`;
    useEffect(() => {
        const unasked = [...claims].filter(
            ([seat, claim]) => !checked.current.has(claimKey(seat, claim))
        );
        if (unasked.length === 0) {
            setVouched((was) => settleVouched(was, claims, checked.current));
            return;
        }
        for (const [seat, claim] of unasked) checked.current.set(claimKey(seat, claim), false);
        let live = true;
        void api
            .vouchCallGames(
                meetingId,
                unasked.map(([seat, claim]) => ({ seat, claim }))
            )
            .then(({ seats, now }) => {
                for (const [seat, claim] of unasked)
                    checked.current.set(claimKey(seat, claim), seats.includes(seat));
                if (!live) return;
                setSkew(now - Date.now());
                setVouched((was) => settleVouched(was, claims, checked.current));
            })
            .catch(() => {
                // Asked again the next time anything changes, rather than never.
                for (const [seat, claim] of unasked) checked.current.delete(claimKey(seat, claim));
            });
        return () => {
            live = false;
        };
    }, [claims, meetingId, api]);

    const session = useMemo(() => {
        const people = [...claims].map(([seat, claim]) => ({ seat, claim }));
        const trusted = new Set(vouched);
        if (mine && self) {
            people.push({ seat: self, claim: mine });
            trusted.add(self);
        }
        return callGame.activitySession(people, trusted, clock);
    }, [claims, vouched, mine, self, clock]);
    const playing = Boolean(session && mine && session.players.includes(self));

    // Renew the pass while playing. The server asks everything again, so a
    // player whose permission was taken away is refused here and leaves.
    useEffect(() => {
        if (!mine) return;
        const due =
            callGame.passExpiresAt(mine.pass) - callGame.RENEW_BEFORE_MS - (Date.now() + skew);
        const timer = window.setTimeout(
            () => {
                void api
                    .renewCallGame(meetingId, mine)
                    .then((result) => {
                        if ("claim" in result) {
                            setSkew(skewFrom(result.claim));
                            setMine(result.claim);
                            setActivity(callGame.encodeClaim(result.claim));
                        } else {
                            setMine(null);
                            setActivity("");
                            setAnswer({ ok: false, reason: result.reason });
                        }
                    })
                    // Offline for a moment: tried again on the clock's next
                    // tick, and the pass carries on until it runs out.
                    .catch(() => undefined);
            },
            Math.max(0, due)
        );
        return () => window.clearTimeout(timer);
    }, [mine, meetingId, clock, skew, setActivity, api]);

    // Asked afresh every time, so a permission given back or a seat admitted
    // since shows the next time anybody looks.
    const ask = useCallback(() => {
        if (!enabled || asking.current) return;
        asking.current = true;
        void api
            .callGames(meetingId)
            .then(setAnswer)
            .catch(() => undefined)
            .finally(() => {
                asking.current = false;
            });
    }, [meetingId, enabled, api]);
    // As the reader takes their seat, so the button shows only to whoever may
    // use it, and when somebody starts a game, so the line can offer it.
    const running = session !== null;
    useEffect(() => {
        if (self) ask();
    }, [self, ask]);
    useEffect(() => {
        if (running) ask();
    }, [running, ask]);

    // The card in the conversation stops counting the reader. Best effort:
    // their pass running out does the same a few minutes later.
    const held = useRef(false);
    held.current = mine !== null;
    const leave = useCallback(() => {
        if (held.current) void api.leaveCallGame(meetingId).catch(() => undefined);
        held.current = false;
        setMine(null);
        setActivity("");
    }, [meetingId, setActivity, api]);

    const play = useCallback(
        (game: string) => {
            setBusy(true);
            void api
                .claimCallGame(meetingId, game)
                .then((result) => {
                    if ("claim" in result) {
                        setSkew(skewFrom(result.claim));
                        setMine(result.claim);
                        setActivity(callGame.encodeClaim(result.claim));
                    } else {
                        setAnswer({ ok: false, reason: result.reason });
                    }
                })
                .catch(() => undefined)
                .finally(() => setBusy(false));
        },
        [meetingId, setActivity, api]
    );

    // Started a game at the same moment as somebody else and lost: the call
    // plays theirs, so this claim is taken back and the line offers theirs.
    useEffect(() => {
        if (mine && session && session.game !== mine.game) leave();
    }, [mine, session, leave]);

    // Leaving the call, or closing it, ends taking part.
    useEffect(
        () => () => {
            if (held.current) void api.leaveCallGame(meetingId).catch(() => undefined);
            setActivity("");
        },
        [meetingId, setActivity, api]
    );

    // A game asked for from its card, a notification or an invitation: played
    // once the server has said whether the reader may.
    const answered = answer?.ok === true;
    useEffect(() => {
        if (!enabled || !self) return;
        const take = () => {
            if (!answered) {
                ask();
                return;
            }
            const game = takeActivityJoin(meetingId);
            if (game && !held.current) play(game);
        };
        take();
        return onActivityJoin(take);
    }, [enabled, self, answered, meetingId, ask, play]);

    const [focused, setFocused] = useState(false);

    const nameOf = useCallback(
        (seat: string) =>
            call.meeting?.participants.find((person) => person.id === seat)?.name ?? "",
        [call.meeting]
    );
    const gameName = useCallback(
        (id: string) =>
            answer?.ok ? (answer.games.find((game) => game.id === id)?.name ?? null) : null,
        [answer]
    );

    const host = usePoseSync({ call, self, session, playing, nameOf });

    return {
        session,
        mine,
        playing,
        answer,
        busy,
        gameName,
        nameOf,
        ask,
        play,
        leave,
        host,
        focused: focused && playing,
        setFocused
    };
}

/** The vouched seats, keeping the same set when nothing changed. */
function settleVouched(
    was: ReadonlySet<string>,
    claims: ReadonlyMap<string, callGame.ActivityClaim>,
    checked: ReadonlyMap<string, boolean>
): ReadonlySet<string> {
    const next = new Set(
        [...claims]
            .filter(([seat, claim]) => checked.get(`${seat}|${claim.pass}`))
            .map(([seat]) => seat)
    );
    return next.size === was.size && [...next].every((seat) => was.has(seat)) ? was : next;
}

type PlayersListener = (players: readonly callGame.FramePlayer[]) => void;

/** Positions between the game and the other players: what the game is handed
 *  while the reader plays. */
function usePoseSync({
    call,
    self,
    session,
    playing,
    nameOf
}: {
    call: ActivityTransport;
    self: string;
    session: callGame.ActivitySession | null;
    playing: boolean;
    nameOf: (seat: string) => string;
}): CallActivityHost | null {
    const poses = useRef(new Map<string, callGame.Pose>());
    const heardAt = useRef(new Map<string, number>());
    const listeners = useRef(new Set<PlayersListener>());
    const live = useRef({ session, self, playing, nameOf });
    live.current = { session, self, playing, nameOf };
    const timer = useRef<number | null>(null);

    const pushPlayers = useCallback(() => {
        if (timer.current !== null || listeners.current.size === 0) return;
        timer.current = window.setTimeout(() => {
            timer.current = null;
            const { session: now, self: me, playing: inGame, nameOf: name } = live.current;
            if (!now || !inGame) return;
            const players = callGame.framePlayers(now, me, poses.current, name);
            for (const listener of listeners.current) listener(players);
        }, callGame.POSE_EVERY_MS);
    }, []);
    useEffect(
        () => () => {
            if (timer.current !== null) window.clearTimeout(timer.current);
        },
        []
    );

    // From the other players.
    const { listenActivity, sendActivity } = call;
    useEffect(
        () =>
            listenActivity((from, raw) => {
                const message = callGame.readActivityMessage(raw);
                if (!message) return;
                const { session: now, self: me } = live.current;
                const at = Date.now();
                if (!callGame.acceptPose(now, me, from, message, heardAt.current.get(from), at))
                    return;
                heardAt.current.set(from, at);
                poses.current.set(from, message.pose);
                pushPlayers();
            }),
        [listenActivity, pushPlayers]
    );

    // Forget whoever left the game.
    useEffect(() => {
        const players = new Set(session?.players ?? []);
        for (const seat of [...poses.current.keys()]) {
            if (!players.has(seat)) {
                poses.current.delete(seat);
                heardAt.current.delete(seat);
            }
        }
        if (playing) pushPlayers();
    }, [session, playing, pushPlayers]);

    const onPlayers = useCallback(
        (listener: PlayersListener) => {
            listeners.current.add(listener);
            pushPlayers();
            return () => {
                listeners.current.delete(listener);
            };
        },
        [pushPlayers]
    );

    // To the other players: only a position that fits, and only while playing.
    const onState = useCallback(
        (state: unknown) => {
            const pose = callGame.readFramePose(state);
            const { session: now, self: me, playing: inGame } = live.current;
            if (!pose || !now || !inGame) return;
            sendActivity(
                now.players.filter((seat) => seat !== me),
                { kind: "pose", game: now.game, pose }
            );
        },
        [sendActivity]
    );

    const name = nameOf(self).trim().slice(0, 64) || "?";
    return useMemo(
        () => (playing && self ? { self: { id: self, name }, onPlayers, onState } : null),
        [playing, self, name, onPlayers, onState]
    );
}

/** The games button, beside the hand. Drawn for whoever may play here, and
 *  muted with the reason for whoever may not yet; not drawn where there is no
 *  game to offer. */
export function CallGamesButton({ activity }: { activity: CallActivity }) {
    const t = useTranslations("chat");
    const [open, setOpen] = useState(false);
    const { answer, session, playing } = activity;
    if (!answer || (!answer.ok && answer.reason === "missing")) return null;
    const refused = answer.ok ? null : refusal(t, answer.reason);
    return (
        <>
            <button
                type="button"
                onClick={() => {
                    activity.ask();
                    setOpen(true);
                }}
                aria-label={t("callGames.button")}
                title={refused ?? t("callGames.button")}
                aria-pressed={playing}
                className={cn(
                    "flex items-center gap-1 rounded p-1.5 transition-colors",
                    playing
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    refused && "opacity-50"
                )}
            >
                <Rocket className="size-4 shrink-0" />
            </button>
            {open && (
                <Dialog open onOpenChange={setOpen}>
                    <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto overscroll-contain">
                        <DialogHeader>
                            <DialogTitle>{t("callGames.title")}</DialogTitle>
                            <DialogDescription>{t("callGames.synced")}</DialogDescription>
                        </DialogHeader>
                        {answer === null ? (
                            <p className="text-sm text-muted-foreground">
                                {t("callGames.checking")}
                            </p>
                        ) : !answer.ok ? (
                            <p className="text-sm text-muted-foreground">
                                {refusal(t, answer.reason)}
                            </p>
                        ) : (
                            <ul className="flex flex-col gap-2">
                                {answer.games.map((game) => {
                                    const running = session?.game === game.id;
                                    const other = session !== null && !running;
                                    return (
                                        <li
                                            key={game.id}
                                            className="flex min-w-0 items-center gap-3 rounded-md border p-3"
                                        >
                                            <Joystick className="size-5 shrink-0 text-muted-foreground" />
                                            <div className="min-w-0 flex-1">
                                                <p
                                                    className="truncate font-medium"
                                                    title={game.name}
                                                >
                                                    {game.name}
                                                </p>
                                                {running && session && (
                                                    <p className="text-xs text-muted-foreground">
                                                        {t("callGames.playing", {
                                                            count: session.players.length
                                                        })}
                                                    </p>
                                                )}
                                                {other && (
                                                    <p className="text-xs text-muted-foreground">
                                                        {t("callGames.oneAtATime")}
                                                    </p>
                                                )}
                                            </div>
                                            <Button
                                                size="sm"
                                                disabled={
                                                    activity.busy || other || (running && playing)
                                                }
                                                onClick={() => {
                                                    activity.play(game.id);
                                                    setOpen(false);
                                                }}
                                            >
                                                {running
                                                    ? t("callGames.join")
                                                    : t("callGames.start")}
                                            </Button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </DialogContent>
                </Dialog>
            )}
        </>
    );
}

function refusal(
    t: ReturnType<typeof useTranslations<"chat">>,
    reason: actions.CallGamesRefusal
): string {
    if (reason === "denied") return t("callGames.denied");
    if (reason === "seat") return t("callGames.seat");
    return t("callGames.missing");
}

/**
 * The line that offers a running game to whoever is not in it, and the game
 * itself for whoever is.
 */
export function CallGamesPanel({
    activity,
    onInvite,
    onLeave
}: {
    activity: CallActivity;
    /** Shown as "Invite friends" while the reader plays. */
    onInvite?: () => void;
    /** Instead of the plain Leave, for a lobby whose page goes back. */
    onLeave?: () => void;
}) {
    const t = useTranslations("chat");
    const { session, playing, answer, host } = activity;
    const [frame, setFrame] = useState<HTMLElement | null>(null);
    if (!session) return null;
    const game = activity.gameName(session.game) ?? t("callGames.someGame");
    const offer = answer?.ok ? answer.games.find((entry) => entry.id === session.game) : undefined;

    if (!playing || !host || !offer?.slot.bundle) {
        const starter = activity.nameOf(session.startedBy) || t("callGames.someone");
        return (
            <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                <Joystick className="size-4 shrink-0 text-muted-foreground" />
                <span
                    className="min-w-0 flex-1 truncate"
                    title={t("callGames.started", { name: starter, game })}
                >
                    {t("callGames.started", { name: starter, game })}
                    <span className="text-muted-foreground">
                        {" - "}
                        {t("callGames.playing", { count: session.players.length })}
                    </span>
                </span>
                <ul
                    className="flex shrink-0 -space-x-1.5"
                    aria-label={t("activityCard.whoIsPlaying")}
                >
                    {session.players.slice(0, 6).map((seat) => (
                        <li
                            key={seat}
                            title={activity.nameOf(seat)}
                            className="rounded-full ring-2 ring-background"
                        >
                            <Avatar
                                person={{ id: seat, name: activity.nameOf(seat) || "?" }}
                                size={20}
                                status={false}
                            />
                        </li>
                    ))}
                </ul>
                {answer === null ? null : answer.ok ? (
                    <Button
                        size="sm"
                        disabled={activity.busy}
                        onClick={() => activity.play(session.game)}
                    >
                        {t("callGames.join")}
                    </Button>
                ) : (
                    <span className="min-w-0 text-xs text-muted-foreground">
                        {refusal(t, answer.reason)}
                    </span>
                )}
            </div>
        );
    }

    return (
        <section
            ref={setFrame}
            aria-label={game}
            className={cn(
                "flex min-h-[16rem] min-w-0 flex-col overflow-hidden rounded-md border bg-background",
                activity.focused ? "flex-[6]" : "flex-[2]"
            )}
        >
            <div className="flex min-w-0 shrink-0 items-center gap-2 border-b px-3 py-1.5 text-sm">
                <Joystick className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium" title={game}>
                    {game}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                    {t("callGames.playing", { count: session.players.length })}
                </span>
                <button
                    type="button"
                    onClick={() => activity.setFocused(!activity.focused)}
                    aria-pressed={activity.focused}
                    aria-label={activity.focused ? t("callGames.unfocus") : t("callGames.focus")}
                    title={activity.focused ? t("callGames.unfocus") : t("callGames.focus")}
                    className="hidden shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground sm:block"
                >
                    {activity.focused ? (
                        <Minimize2 className="size-4" />
                    ) : (
                        <Maximize2 className="size-4" />
                    )}
                </button>
                <FullscreenButton target={frame} />
                {onInvite && (
                    <button
                        type="button"
                        onClick={onInvite}
                        aria-label={t("callGames.invite")}
                        title={t("callGames.invite")}
                        className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                        <UserPlus className="size-4" />
                    </button>
                )}
                <Button size="sm" variant="ghost" onClick={onLeave ?? activity.leave}>
                    <LogOut className="size-4" />
                    {t("callGames.leave")}
                </Button>
            </div>
            <div className="relative min-h-0 flex-1 bg-black">
                <div className="absolute inset-0">
                    <AppSlotView slot={offer.slot} host={host} />
                </div>
            </div>
        </section>
    );
}

/** Whether this element is what the browser is showing full screen. */
function useFullscreen(target: HTMLElement | null): boolean {
    const [on, setOn] = useState(false);
    useEffect(() => {
        const read = () => setOn(target !== null && document.fullscreenElement === target);
        read();
        document.addEventListener("fullscreenchange", read);
        return () => document.removeEventListener("fullscreenchange", read);
    }, [target]);
    return on;
}

/** Full screen for the game, and back. Escape leaves it too, as the browser
 *  always allows; hidden where the browser offers no full screen. */
function FullscreenButton({ target }: { target: HTMLElement | null }) {
    const t = useTranslations("chat");
    const on = useFullscreen(target);
    if (!target || typeof document === "undefined" || !document.fullscreenEnabled) return null;
    const label = on ? t("callGames.exitFullscreen") : t("callGames.fullscreen");
    return (
        <button
            type="button"
            onClick={() => {
                if (on) void document.exitFullscreen().catch(() => undefined);
                else void target.requestFullscreen().catch(() => undefined);
            }}
            aria-pressed={on}
            aria-label={label}
            title={label}
            className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
            {on ? <Shrink className="size-4" /> : <Expand className="size-4" />}
        </button>
    );
}
