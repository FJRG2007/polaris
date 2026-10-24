"use client";

/**
 * Games in a call: the button that starts one, the line that offers it to
 * everybody else, and the game itself, framed inside the call.
 *
 * What is synced, and nothing more: who is playing (each player's own claim,
 * vouched for by the server) and each player's position, heading and vehicle,
 * passed only between the players. Every browser runs its own city; traffic,
 * people on the street and everything else in it are not shared.
 *
 * Nothing here loads until somebody presses the button or somebody in the call
 * is playing: a call where nobody plays asks the server nothing.
 */

import type { CallState } from "./call-state";
import { Joystick, LogOut } from "lucide-react";
import * as actions from "./call-activity-actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type Loading =
    | { readonly kind: "loading"; readonly done: number }
    | { readonly kind: "ready" }
    | { readonly kind: "failed"; readonly graphics: boolean };

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
    readonly frame: React.RefObject<HTMLIFrameElement | null>;
    readonly loading: Loading;
}

/** Everything a call needs to play together, for the button, the line and the
 *  frame to share. */
/** Off for a guest, who has no account to hold `arcade.calls` with. */
export function useCallActivity(
    meetingId: string,
    call: CallState,
    enabled: boolean
): CallActivity {
    const self = call.participantId ?? "";
    const [mine, setMine] = useState<callGame.ActivityClaim | null>(null);
    const [vouched, setVouched] = useState<ReadonlySet<string>>(new Set());
    const [answer, setAnswer] = useState<actions.CallGamesAnswer | null>(null);
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState<Loading>({ kind: "loading", done: 0 });
    const frame = useRef<HTMLIFrameElement | null>(null);
    const asked = useRef(false);
    const { setActivity } = call;
    // The moment claims are judged against, so a pass that ran out stops
    // counting without anybody having to say so.
    const [clock, setClock] = useState(() => Date.now());
    const anyClaims = call.states.size > 0 && enabled;
    useEffect(() => {
        if (!anyClaims) return;
        const timer = window.setInterval(() => setClock(Date.now()), 30_000);
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
        void actions
            .vouchCallGames(
                meetingId,
                unasked.map(([seat, claim]) => ({ seat, claim }))
            )
            .then((good) => {
                for (const [seat, claim] of unasked)
                    checked.current.set(claimKey(seat, claim), good.includes(seat));
                if (live) setVouched((was) => settleVouched(was, claims, checked.current));
            })
            .catch(() => {
                // Asked again the next time anything changes, rather than never.
                for (const [seat, claim] of unasked) checked.current.delete(claimKey(seat, claim));
            });
        return () => {
            live = false;
        };
    }, [claims, meetingId]);

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
        const due = callGame.passExpiresAt(mine.pass) - callGame.RENEW_BEFORE_MS - Date.now();
        const timer = window.setTimeout(
            () => {
                void actions
                    .renewCallGame(meetingId, mine)
                    .then((result) => {
                        if ("claim" in result) {
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
    }, [mine, meetingId, clock, setActivity]);

    const ask = useCallback(() => {
        if (asked.current) return;
        asked.current = true;
        void actions
            .callGames(meetingId)
            .then(setAnswer)
            .catch(() => {
                asked.current = false;
            });
    }, [meetingId]);
    // Somebody is playing: find out whether the reader may join, and what the
    // game is called.
    useEffect(() => {
        if (session) ask();
    }, [session, ask]);

    const leave = useCallback(() => {
        setMine(null);
        setActivity("");
    }, [setActivity]);

    const play = useCallback(
        (game: string) => {
            setBusy(true);
            void actions
                .claimCallGame(meetingId, game)
                .then((result) => {
                    if ("claim" in result) {
                        setLoading({ kind: "loading", done: 0 });
                        setMine(result.claim);
                        setActivity(callGame.encodeClaim(result.claim));
                    } else {
                        setAnswer({ ok: false, reason: result.reason });
                    }
                })
                .catch(() => undefined)
                .finally(() => setBusy(false));
        },
        [meetingId, setActivity]
    );

    // Started a game at the same moment as somebody else and lost: the call
    // plays theirs, so this claim is taken back and the line offers theirs.
    useEffect(() => {
        if (mine && session && session.game !== mine.game) leave();
    }, [mine, session, leave]);

    // Leaving the call, or closing it, ends taking part.
    useEffect(() => () => setActivity(""), [setActivity]);

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

    usePoseSync({ call, self, session, playing, frame, nameOf, setLoading });

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
        frame,
        loading
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

/** Positions between the frame and the other players. */
function usePoseSync({
    call,
    self,
    session,
    playing,
    frame,
    nameOf,
    setLoading
}: {
    call: CallState;
    self: string;
    session: callGame.ActivitySession | null;
    playing: boolean;
    frame: React.RefObject<HTMLIFrameElement | null>;
    nameOf: (seat: string) => string;
    setLoading: (loading: Loading) => void;
}): void {
    const poses = useRef(new Map<string, callGame.Pose>());
    const heardAt = useRef(new Map<string, number>());
    const live = useRef({ session, self, playing, nameOf });
    live.current = { session, self, playing, nameOf };
    const timer = useRef<number | null>(null);

    const post = useCallback(
        (message: unknown) => frame.current?.contentWindow?.postMessage(message, location.origin),
        [frame]
    );
    const pushPlayers = useCallback(() => {
        if (timer.current !== null) return;
        timer.current = window.setTimeout(() => {
            timer.current = null;
            const { session: now, self: me, playing: inGame, nameOf: name } = live.current;
            if (!now || !inGame) return;
            post({
                type: "polaris-game:players",
                players: callGame.framePlayers(now, me, poses.current, name)
            });
        }, callGame.POSE_EVERY_MS);
    }, [post]);
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

    // From the frame: the same origin, the frame itself, and the contract's
    // shapes only.
    useEffect(() => {
        if (!playing) return;
        function onMessage(event: MessageEvent): void {
            if (event.origin !== location.origin || event.source !== frame.current?.contentWindow)
                return;
            const message = callGame.readFrameMessage(event.data);
            if (!message) return;
            const { session: now, self: me, nameOf: name } = live.current;
            if (message.type === "polaris-game:progress") {
                setLoading({ kind: "loading", done: message.done });
            } else if (message.type === "polaris-game:ready") {
                setLoading({ kind: "ready" });
                post({
                    type: "polaris-game:join",
                    self: { id: me, name: name(me).trim().slice(0, 64) || "?" }
                });
                pushPlayers();
            } else if (message.type === "polaris-game:failed") {
                setLoading({ kind: "failed", graphics: message.reason === "graphics" });
            } else if (now) {
                const { x, y, z, heading, mode } = message;
                sendActivity(
                    now.players.filter((seat) => seat !== me),
                    { kind: "pose", game: now.game, pose: { x, y, z, heading, mode } }
                );
            }
        }
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [playing, frame, post, pushPlayers, sendActivity, setLoading]);
}

/** The games button, beside the hand. Drawn for anybody with an account. */
export function CallGamesButton({ activity }: { activity: CallActivity }) {
    const t = useTranslations("chat");
    const [open, setOpen] = useState(false);
    const { answer, session, playing } = activity;
    return (
        <>
            <button
                type="button"
                onClick={() => {
                    activity.ask();
                    setOpen(true);
                }}
                aria-label={t("callGames.button")}
                title={t("callGames.button")}
                aria-pressed={playing}
                className={cn(
                    "flex items-center gap-1 rounded p-1.5 transition-colors",
                    playing
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
            >
                <Joystick className="size-4 shrink-0" />
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
export function CallGamesPanel({ activity }: { activity: CallActivity }) {
    const t = useTranslations("chat");
    const { session, playing, answer, loading } = activity;
    if (!session) return null;
    const game = activity.gameName(session.game) ?? t("callGames.someGame");
    const src = answer?.ok
        ? answer.games.find((entry) => entry.id === session.game)?.src
        : undefined;

    if (!playing || !src) {
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
            aria-label={game}
            className="flex min-h-[16rem] min-w-0 flex-[2] flex-col overflow-hidden rounded-md border"
        >
            <div className="flex min-w-0 shrink-0 items-center gap-2 border-b px-3 py-1.5 text-sm">
                <Joystick className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium" title={game}>
                    {game}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                    {t("callGames.playing", { count: session.players.length })}
                </span>
                <Button size="sm" variant="ghost" onClick={activity.leave}>
                    <LogOut className="size-4" />
                    {t("callGames.leave")}
                </Button>
            </div>
            <div className="relative min-h-0 flex-1 bg-black">
                <iframe
                    ref={activity.frame}
                    src={src}
                    title={game}
                    allow="fullscreen; gamepad"
                    className="absolute inset-0 size-full border-0"
                />
                {loading.kind !== "ready" && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/90 p-4 text-center text-sm">
                        {loading.kind === "failed" ? (
                            <p>
                                {loading.graphics
                                    ? t("callGames.noGraphics")
                                    : t("callGames.failed")}
                            </p>
                        ) : (
                            <>
                                <p>{t("callGames.loading", { game })}</p>
                                <div
                                    role="progressbar"
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={Math.round(loading.done * 100)}
                                    className="h-1.5 w-48 max-w-full overflow-hidden rounded-full bg-muted"
                                >
                                    <div
                                        className="h-full bg-primary transition-[width]"
                                        style={{ width: `${Math.round(loading.done * 100)}%` }}
                                    />
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>
        </section>
    );
}
